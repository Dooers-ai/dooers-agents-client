import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { productionUploadFilename } from '../upload-filename'
import type { DooersThreadsUploadOptions } from './artifacts.js'
import { DooersThreadsClient } from './client.js'
import type {
  DooersThreadsClientConfig,
  DooersThreadsSendInput,
  DooersThreadsTransport,
} from './types.js'

const DooersThreadsContext = createContext<DooersThreadsClient | null>(null)
export interface DooersThreadsProviderProps {
  config: DooersThreadsClientConfig
  children: ReactNode
}

/** Independent of AgentProvider. Private settings/analytics retain their own provider. */
export function DooersThreadsProvider({ config, children }: DooersThreadsProviderProps) {
  const configRef = useRef(config)
  configRef.current = config
  // Scalar identity changes create an empty client before children render. Old
  // requests are aborted in effect cleanup and cannot reach the new instance.
  const key = JSON.stringify([
    config.mode,
    config.durableForms,
    config.toolApprovals,
    config.perAgentOptions,
    config.endpoint,
    config.apiPrefix,
    config.scope.principalId,
    config.scope.organizationId,
    config.scope.workspaceId,
    config.transport,
    config.allowInsecureLocalhost,
    config.requestTimeoutMs,
    config.heartbeatMs,
    config.maxReconnectAttempts,
    config.reconnectBaseMs,
    config.reconnectMaxMs,
    config.maxResponseBytes,
    config.maxArtifactBytes,
    config.maxPublications,
    config.maxBufferedEvents,
    config.maxEventsPerThread,
    config.maxThreads,
    config.maxReplayAttempts,
    config.replayRetryMs,
  ])
  // biome-ignore lint/correctness/useExhaustiveDependencies: scalar session key intentionally recreates the isolated client; callbacks stay current through the ref.
  const client = useMemo(
    () =>
      new DooersThreadsClient({
        ...configRef.current,
        onError: (failure) => configRef.current.onError?.(failure),
        onAuthRequired: (reason) => configRef.current.onAuthRequired?.(reason),
      }),
    [key, config.fetch, config.socketFactory]
  )
  const previous = useRef({ client, credential: config.authToken })
  useEffect(() => {
    void client.connect().catch(() => {})
    // disconnect supports React StrictMode's setup/cleanup/setup cycle. Contents
    // are cleared on unmount while a remount never resends a publication.
    return () => {
      client.reset()
    }
  }, [client])
  useEffect(() => {
    const changed =
      previous.current.client === client && previous.current.credential !== config.authToken
    previous.current = { client, credential: config.authToken }
    if (changed) void client.refreshAuth(config.authToken).catch(() => {})
  }, [client, config.authToken])
  return <DooersThreadsContext.Provider value={client}>{children}</DooersThreadsContext.Provider>
}

/** Binds an explicitly owned session. The caller owns connect/reset and its grant lifetime. */
export function DooersThreadsClientProvider({
  client,
  children,
}: {
  client: DooersThreadsClient
  children: ReactNode
}) {
  return <DooersThreadsContext.Provider value={client}>{children}</DooersThreadsContext.Provider>
}

export function useDooersThreadsClient() {
  const client = useContext(DooersThreadsContext)
  if (!client) throw new Error('Dooers Threads hooks require a DooersThreadsProvider')
  return client
}
export function useDooersThreadsConnection() {
  const client = useDooersThreadsClient()
  return useSyncExternalStore(
    client.subscribeConnection,
    client.getConnection,
    client.getConnection
  )
}
export function useDooersThreadsPublications() {
  const client = useDooersThreadsClient()
  return useSyncExternalStore(
    client.publications.subscribe,
    client.publications.getSnapshot,
    client.publications.getSnapshot
  )
}
export function useDooersThreadsMessage() {
  const client = useDooersThreadsClient()
  const snapshot = useDooersThreadsPublications()
  return useMemo(
    () => ({
      ...snapshot,
      prepare: (input: DooersThreadsSendInput) => client.prepareMessage(input),
      send: (input: DooersThreadsSendInput, options?: { transport?: DooersThreadsTransport }) =>
        client.send(input, options),
      retry: (
        threadId: string,
        clientEventId: string,
        options?: { transport?: DooersThreadsTransport }
      ) => client.retry(threadId, clientEventId, options),
    }),
    [client, snapshot]
  )
}

export function useDooersThreadsThreads() {
  const client = useDooersThreadsClient()
  return useSyncExternalStore(
    client.store.subscribe,
    client.store.getSnapshot,
    client.store.getSnapshot
  )
}
/** Every mounted consumer owns a reference; only the final cleanup unsubscribes. */
export function useDooersThreadsThread(threadId: string) {
  const client = useDooersThreadsClient()
  const id = client.normalizeThreadId(threadId)
  const snapshot = useDooersThreadsThreads()
  useEffect(() => client.retainThread(id), [client, id])
  return useMemo(
    () => ({
      state: snapshot.threads[id],
      loadBefore: (options?: { before?: string; limit?: number }) => client.loadBefore(id, options),
      retryReplay: (options?: { snapshot?: boolean }) => client.retryReplay(id, options),
    }),
    [client, id, snapshot]
  )
}
export function useDooersThreadsParticipants(threadId: string) {
  const { state } = useDooersThreadsThread(threadId)
  return useMemo(() => Object.values(state?.participantsById ?? {}), [state?.participantsById])
}
export function useDooersThreadsExecutions(threadId: string) {
  const { state } = useDooersThreadsThread(threadId)
  return useMemo(
    () => ({
      executions: Object.values(state?.executionsById ?? {}),
      deliveries: Object.values(state?.deliveriesById ?? {}),
      hasPendingWork: state?.hasPendingWork ?? false,
      waitingForInput: state?.waitingForInput ?? false,
    }),
    [state?.executionsById, state?.deliveriesById, state?.hasPendingWork, state?.waitingForInput]
  )
}

/** Provisional text only; canonical messages remain in state.eventsById. */
export function useDooersThreadsStreams(threadId: string) {
  const { state } = useDooersThreadsThread(threadId)
  return useMemo(
    () => ({
      streams: Object.values(state?.streamsByKey ?? {}),
      resyncRequired: state?.streamResyncRequired ?? false,
    }),
    [state?.streamsByKey, state?.streamResyncRequired]
  )
}

/** ACK receipts remain separate from canonical execution/root outcomes. */
export function useDooersThreadsControls() {
  const client = useDooersThreadsClient()
  return useSyncExternalStore(
    client.controls.subscribe,
    client.controls.getSnapshot,
    client.controls.getSnapshot
  )
}

/** Pending files remain private to this scoped client; never dispatch through AgentProvider. */
export function useDooersThreadsUploads() {
  const client = useDooersThreadsClient()
  const drafts = useSyncExternalStore(
    client.artifacts.subscribe,
    client.artifacts.getSnapshot,
    client.artifacts.getSnapshot
  )
  return useMemo(
    () => ({
      drafts,
      // The name production's upload sends (trimmed, `upload`, `recording.webm` for a recorded Blob).
      add: (file: Blob, filename: string, options?: DooersThreadsUploadOptions) =>
        client.artifacts.add(file, productionUploadFilename(file, filename), options),
      retry: (id: string) => client.artifacts.retry(id),
      remove: (id: string) => client.artifacts.remove(id),
      clear: () => client.artifacts.clearUploads(),
      content: () => client.artifacts.content(),
    }),
    [client, drafts]
  )
}

export function useDooersThreadsFeedback(threadId: string, eventId: string) {
  const client = useDooersThreadsClient()
  const receipts = useSyncExternalStore(
    client.feedback.subscribe,
    client.feedback.getSnapshot,
    client.feedback.getSnapshot
  )
  useDooersThreadsThreads()
  const current = client.feedback.current(threadId, eventId)
  const refreshRequired = client.feedback.requiresRefresh(threadId, eventId)
  return useMemo(
    () => ({
      current,
      refreshRequired,
      receipt: receipts.find(
        (item) => item.intent.threadId === threadId && item.intent.eventId === eventId
      ),
      submit: (input: {
        value: 'positive' | 'negative' | null
        classification?: string | null
        reason?: string | null
      }) => client.feedback.request({ threadId, eventId, ...input }),
      retry: () => client.feedback.retry(threadId, eventId),
    }),
    [client, threadId, eventId, receipts, current, refreshRequired]
  )
}
export function useDooersThreadsExport(threadId: string) {
  const client = useDooersThreadsClient()
  const receipts = useSyncExternalStore(
    client.exports.subscribe,
    client.exports.getSnapshot,
    client.exports.getSnapshot
  )
  return useMemo(
    () => ({
      receipt: receipts.find((item) => item.threadId === threadId),
      request: (options?: { watermark?: string }) => client.exports.request(threadId, options),
      retry: () => client.exports.retry(threadId),
      open: () => client.exports.open(threadId),
    }),
    [client, threadId, receipts]
  )
}

/** Durable forms are reconstructed from authorized canonical events, never legacy useForm. */
export function useDooersThreadsInteractions(threadId: string) {
  const client = useDooersThreadsClient()
  useDooersThreadsThread(threadId)
  return client.interactions.list(threadId)
}
export function useDooersThreadsInteraction(threadId: string, interactionId: string) {
  const client = useDooersThreadsClient()
  const id = client.normalizeThreadId(threadId)
  const target = client.normalizeThreadId(interactionId)
  const { state, retryReplay } = useDooersThreadsThread(id)
  const receipts = useSyncExternalStore(
    client.interactions.subscribe,
    client.interactions.getSnapshot,
    client.interactions.getSnapshot
  )
  const connection = useDooersThreadsConnection()
  const uploads = useSyncExternalStore(
    client.interactionUploads.subscribe,
    client.interactionUploads.getSnapshot,
    client.interactionUploads.getSnapshot
  )
  const current = client.interactions.current(id, target)
  const member = Object.values(state?.participantsById ?? {}).find(
    (item) =>
      item.kind === 'human' &&
      item.principalId === client.scope.principalId &&
      item.state === 'active'
  )
  const eligible =
    client.durableFormsEnabled &&
    connection.status === 'connected' &&
    connection.capabilities.includes('interactions.forms') &&
    state?.phase === 'live' &&
    state.thread?.state === 'active' &&
    state.thread.permissions.write &&
    state.thread.capabilities.includes('interactions.forms') &&
    !client.isSupervision(id) &&
    current?.state === 'pending' &&
    Date.parse(current.interaction.definition.expires_at) > Date.now() &&
    !!member &&
    current.interaction.definition.eligible_participant_ids.includes(member.participantId)
  const restores = useSyncExternalStore(
    client.interactionUploads.subscribe,
    client.interactionUploads.getRestoreSnapshot,
    client.interactionUploads.getRestoreSnapshot
  )
  const restoration = restores.find((item) => item.threadId === id && item.interactionId === target)
  const needsRecovery =
    current?.interaction.definition.kind === 'form' &&
    current.interaction.definition.fields.some((field) => field.type === 'artifact')
  useEffect(() => {
    if (!eligible || !needsRecovery) return
    const release = client.interactionUploads.retain(id, target)
    void client.interactionUploads.restore(id, target).catch(() => {})
    return release
  }, [client, id, target, eligible, needsRecovery])
  const canRespond = eligible && (!needsRecovery || restoration?.state === 'ready')
  return {
    current,
    canRespond: !!canRespond,
    canCancel: !!eligible,
    isRestoring: !!needsRecovery && eligible && (!restoration || restoration.state === 'pending'),
    fieldsError: restoration?.errorCode ?? null,
    restoreFields: () => client.interactionUploads.restore(id, target, true),
    receipt: receipts.find(
      (item) => item.intent.threadId === id && item.intent.interactionId === target
    ),
    submit: (
      data: Extract<
        import('./interactions.js').DooersThreadsFormResponse,
        { action: 'submit' }
      >['data'],
      options?: { transport?: DooersThreadsTransport }
    ) => client.interactions.request(id, target, { action: 'submit', data }, options),
    cancel: (options?: { transport?: DooersThreadsTransport }) =>
      client.interactions.request(id, target, { action: 'cancel', data: {} }, options),
    retry: (options?: { transport?: DooersThreadsTransport }) =>
      client.interactions.retry(id, target, options),
    retryReplay,
    uploads:
      current?.state === 'pending'
        ? uploads.filter((item) => item.threadId === id && item.interactionId === target)
        : [],
    uploadField: (fieldName: string, file: Blob, filename: string) =>
      client.interactionUploads.add(id, target, fieldName, file, filename),
    retryField: (draftId: string) => client.interactionUploads.retry(draftId),
    removeField: (draftId: string) => client.interactionUploads.remove(draftId),
  }
}

/** Candidate approval hooks observe authorized replay; reconnect never submits a decision. */
export function useDooersThreadsApprovals(threadId: string) {
  const client = useDooersThreadsClient()
  useDooersThreadsThread(threadId)
  useSyncExternalStore(
    client.approvalOutcomes.subscribe,
    client.approvalOutcomes.getSnapshot,
    client.approvalOutcomes.getSnapshot
  )
  return client.approvals.list(threadId)
}
export function useDooersThreadsApproval(threadId: string, interactionId: string) {
  const client = useDooersThreadsClient()
  const id = client.normalizeThreadId(threadId)
  const target = client.normalizeThreadId(interactionId)
  const { state, retryReplay } = useDooersThreadsThread(id)
  const connection = useDooersThreadsConnection()
  const receipts = useSyncExternalStore(
    client.approvals.subscribe,
    client.approvals.getSnapshot,
    client.approvals.getSnapshot
  )
  useEffect(() => client.approvalOutcomes.retain(id, target), [client, id, target])
  const outcomes = useSyncExternalStore(
    client.approvalOutcomes.subscribe,
    client.approvalOutcomes.getSnapshot,
    client.approvalOutcomes.getSnapshot
  )
  const outcomeRead = outcomes.find((item) => item.threadId === id && item.interactionId === target)
  const previousConnection = useRef<string | null>(null)
  const connectionId = connection.handshake?.connectionId ?? null
  const requestedOutcome = !!outcomeRead
  useEffect(() => {
    if (connection.status !== 'connected' || state?.phase !== 'live' || !connectionId) return
    const previous = previousConnection.current
    previousConnection.current = connectionId
    if (previous && previous !== connectionId && requestedOutcome)
      void client.approvalOutcomes.refresh(id, target).catch(() => {})
  }, [client, id, target, connection.status, connectionId, state?.phase, requestedOutcome])
  const current = client.approvals.current(id, target)
  const [, setExpiryTick] = useState(0)
  const expiresAt = current?.interaction.definition.expires_at
  useEffect(() => {
    if (!expiresAt) return
    const remaining = Date.parse(expiresAt) - Date.now()
    if (remaining <= 0 || !Number.isFinite(remaining)) return
    let timer: ReturnType<typeof setTimeout>
    const expire = () => {
      const remaining = Date.parse(expiresAt) - Date.now()
      if (remaining <= 0) setExpiryTick((value) => value + 1)
      else timer = setTimeout(expire, Math.min(remaining, 2147483647))
    }
    timer = setTimeout(expire, Math.min(remaining, 2147483647))
    return () => clearTimeout(timer)
  }, [expiresAt])
  const canRespond = client.canApprove(id, target)
  return {
    current,
    canRespond,
    outcomeRead,
    outcomeAwaitingReplay:
      !!outcomeRead?.result?.decision_event_id &&
      outcomeRead.result.decision_event_id !== current?.decision?.eventId,
    refreshOutcome: () => client.approvalOutcomes.refresh(id, target),
    receipt: receipts.find(
      (item) => item.intent.threadId === id && item.intent.interactionId === target
    ),
    approve: (options?: { transport?: DooersThreadsTransport }) =>
      client.approvals.request(
        id,
        target,
        {
          action: 'approve',
          data: { arguments_hash: current?.interaction.definition.arguments_hash ?? '' },
        },
        options
      ),
    reject: (options?: { transport?: DooersThreadsTransport }) =>
      client.approvals.request(id, target, { action: 'reject', data: {} }, options),
    /** Explicit candidate cancellation; it is not included in definition.actions. */
    cancel: (options?: { transport?: DooersThreadsTransport }) =>
      client.approvals.request(id, target, { action: 'cancel', data: {} }, options),
    retry: (options?: { transport?: DooersThreadsTransport }) =>
      client.approvals.retry(id, target, options),
    retryReplay,
  }
}
