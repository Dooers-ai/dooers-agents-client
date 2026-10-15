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
import type { MaestroUploadOptions } from './artifacts.js'
import { MaestroClient } from './client.js'
import type { MaestroClientConfig, MaestroSendInput, MaestroTransport } from './types.js'

const MaestroContext = createContext<MaestroClient | null>(null)
export interface MaestroProviderProps {
  config: MaestroClientConfig
  children: ReactNode
}

/** Independent of AgentProvider. Private settings/analytics retain their own provider. */
export function MaestroProvider({ config, children }: MaestroProviderProps) {
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
      new MaestroClient({
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
  return <MaestroContext.Provider value={client}>{children}</MaestroContext.Provider>
}

/** Binds an explicitly owned session. The caller owns connect/reset and its grant lifetime. */
export function MaestroClientProvider({
  client,
  children,
}: {
  client: MaestroClient
  children: ReactNode
}) {
  return <MaestroContext.Provider value={client}>{children}</MaestroContext.Provider>
}

export function useMaestroClient() {
  const client = useContext(MaestroContext)
  if (!client) throw new Error('Maestro hooks require a MaestroProvider')
  return client
}
export function useMaestroConnection() {
  const client = useMaestroClient()
  return useSyncExternalStore(
    client.subscribeConnection,
    client.getConnection,
    client.getConnection
  )
}
export function useMaestroPublications() {
  const client = useMaestroClient()
  return useSyncExternalStore(
    client.publications.subscribe,
    client.publications.getSnapshot,
    client.publications.getSnapshot
  )
}
export function useMaestroMessage() {
  const client = useMaestroClient()
  const snapshot = useMaestroPublications()
  return useMemo(
    () => ({
      ...snapshot,
      prepare: (input: MaestroSendInput) => client.prepareMessage(input),
      send: (input: MaestroSendInput, options?: { transport?: MaestroTransport }) =>
        client.send(input, options),
      retry: (
        threadId: string,
        clientEventId: string,
        options?: { transport?: MaestroTransport }
      ) => client.retry(threadId, clientEventId, options),
    }),
    [client, snapshot]
  )
}

export function useMaestroThreads() {
  const client = useMaestroClient()
  return useSyncExternalStore(
    client.store.subscribe,
    client.store.getSnapshot,
    client.store.getSnapshot
  )
}
/** Every mounted consumer owns a reference; only the final cleanup unsubscribes. */
export function useMaestroThread(threadId: string) {
  const client = useMaestroClient()
  const id = client.normalizeThreadId(threadId)
  const snapshot = useMaestroThreads()
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
export function useMaestroParticipants(threadId: string) {
  const { state } = useMaestroThread(threadId)
  return useMemo(() => Object.values(state?.participantsById ?? {}), [state?.participantsById])
}
export function useMaestroExecutions(threadId: string) {
  const { state } = useMaestroThread(threadId)
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
export function useMaestroStreams(threadId: string) {
  const { state } = useMaestroThread(threadId)
  return useMemo(
    () => ({
      streams: Object.values(state?.streamsByKey ?? {}),
      resyncRequired: state?.streamResyncRequired ?? false,
    }),
    [state?.streamsByKey, state?.streamResyncRequired]
  )
}

/** ACK receipts remain separate from canonical execution/root outcomes. */
export function useMaestroControls() {
  const client = useMaestroClient()
  return useSyncExternalStore(
    client.controls.subscribe,
    client.controls.getSnapshot,
    client.controls.getSnapshot
  )
}

/** Pending files remain private to this scoped client; never dispatch through AgentProvider. */
export function useMaestroUploads() {
  const client = useMaestroClient()
  const drafts = useSyncExternalStore(
    client.artifacts.subscribe,
    client.artifacts.getSnapshot,
    client.artifacts.getSnapshot
  )
  return useMemo(
    () => ({
      drafts,
      add: (file: Blob, filename: string, options?: MaestroUploadOptions) =>
        client.artifacts.add(file, filename, options),
      retry: (id: string) => client.artifacts.retry(id),
      remove: (id: string) => client.artifacts.remove(id),
      clear: () => client.artifacts.clearUploads(),
      content: () => client.artifacts.content(),
    }),
    [client, drafts]
  )
}

export function useMaestroFeedback(threadId: string, eventId: string) {
  const client = useMaestroClient()
  const receipts = useSyncExternalStore(
    client.feedback.subscribe,
    client.feedback.getSnapshot,
    client.feedback.getSnapshot
  )
  useMaestroThreads()
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
export function useMaestroExport(threadId: string) {
  const client = useMaestroClient()
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
export function useMaestroInteractions(threadId: string) {
  const client = useMaestroClient()
  useMaestroThread(threadId)
  return client.interactions.list(threadId)
}
export function useMaestroInteraction(threadId: string, interactionId: string) {
  const client = useMaestroClient()
  const id = client.normalizeThreadId(threadId)
  const target = client.normalizeThreadId(interactionId)
  const { state, retryReplay } = useMaestroThread(id)
  const receipts = useSyncExternalStore(
    client.interactions.subscribe,
    client.interactions.getSnapshot,
    client.interactions.getSnapshot
  )
  const connection = useMaestroConnection()
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
      data: Extract<import('./interactions.js').MaestroFormResponse, { action: 'submit' }>['data'],
      options?: { transport?: MaestroTransport }
    ) => client.interactions.request(id, target, { action: 'submit', data }, options),
    cancel: (options?: { transport?: MaestroTransport }) =>
      client.interactions.request(id, target, { action: 'cancel', data: {} }, options),
    retry: (options?: { transport?: MaestroTransport }) =>
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
export function useMaestroApprovals(threadId: string) {
  const client = useMaestroClient()
  useMaestroThread(threadId)
  useSyncExternalStore(
    client.approvalOutcomes.subscribe,
    client.approvalOutcomes.getSnapshot,
    client.approvalOutcomes.getSnapshot
  )
  return client.approvals.list(threadId)
}
export function useMaestroApproval(threadId: string, interactionId: string) {
  const client = useMaestroClient()
  const id = client.normalizeThreadId(threadId)
  const target = client.normalizeThreadId(interactionId)
  const { state, retryReplay } = useMaestroThread(id)
  const connection = useMaestroConnection()
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
    approve: (options?: { transport?: MaestroTransport }) =>
      client.approvals.request(
        id,
        target,
        {
          action: 'approve',
          data: { arguments_hash: current?.interaction.definition.arguments_hash ?? '' },
        },
        options
      ),
    reject: (options?: { transport?: MaestroTransport }) =>
      client.approvals.request(id, target, { action: 'reject', data: {} }, options),
    /** Explicit candidate cancellation; it is not included in definition.actions. */
    cancel: (options?: { transport?: MaestroTransport }) =>
      client.approvals.request(id, target, { action: 'cancel', data: {} }, options),
    retry: (options?: { transport?: MaestroTransport }) =>
      client.approvals.retry(id, target, options),
    retryReplay,
  }
}
