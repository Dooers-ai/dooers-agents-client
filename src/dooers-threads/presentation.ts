import {
  compareDooersThreadsSequences,
  hasDooersThreadsCapability,
} from '../protocol/dooers-threads/contracts.js'
import { dooersThreadsCommercialBlock } from './commercial.js'
import type { DooersThreadsNetworkEvent } from './network.js'
import type {
  DooersThreadsDelivery,
  DooersThreadsExecution,
  DooersThreadsStoreSnapshot,
} from './store.js'
import {
  DooersThreadsClientError,
  type DooersThreadsConnection,
  type DooersThreadsScope,
} from './types.js'

/** Stable identity includes authority and authenticated scope; never key by display name. */
export function dooersThreadsPresentationKey(
  scope: Readonly<DooersThreadsScope>,
  threadId: string
): string {
  return JSON.stringify([
    'dooers_threads',
    scope.principalId,
    scope.organizationId,
    scope.workspaceId,
    threadId,
  ])
}

export function toDooersThreadsDeliveryPresentation(delivery: DooersThreadsDelivery) {
  return {
    deliveryId: delivery.delivery_id,
    triggerEventId: delivery.trigger_event_id,
    participantId: delivery.participant_id,
    state: delivery.state,
    attemptCount: delivery.attempt_count,
    executionId: delivery.execution_id,
    phaseId: delivery.phase_id,
    reasonCode: delivery.reason_code,
    commercialBlock:
      delivery.state === 'failed' ? dooersThreadsCommercialBlock(delivery.reason_code) : null,
    createdAt: delivery.created_at,
    updatedAt: delivery.updated_at,
    completedAt: delivery.completed_at,
    expiresAt: delivery.expires_at,
  }
}
export function toDooersThreadsExecutionPresentation(execution: DooersThreadsExecution) {
  return {
    executionId: execution.execution_id,
    deliveryId: execution.delivery_id,
    participantId: execution.participant_id,
    phaseId: execution.phase_id,
    state: execution.state,
    outcome: execution.outcome,
    reasonCode: execution.reason_code,
    commercialBlock:
      execution.state === 'failed' ? dooersThreadsCommercialBlock(execution.reason_code) : null,
    deadlineAt: execution.deadline_at,
    completedAt: execution.completed_at,
  }
}

function eventPresentation(item: DooersThreadsNetworkEvent) {
  // Unknown payloads are opaque. Never hand arbitrary future/private data to a renderer.
  if (item.known) return { known: true as const, ...item.event }
  const { payload: _payload, ...metadata } = item.event
  return { known: false as const, ...metadata }
}

/** Pure view of the canonical SDK store. It neither reconciles wire events nor authorizes requests. */
export function toDooersThreadsConversationPresentation(
  snapshot: DooersThreadsStoreSnapshot,
  threadId: string,
  connection: Pick<DooersThreadsConnection, 'status' | 'capabilities'>,
  expectedScope: Readonly<DooersThreadsScope>
) {
  const scope = snapshot.scope
  if (
    scope.principalId !== expectedScope.principalId ||
    scope.organizationId !== expectedScope.organizationId ||
    scope.workspaceId !== expectedScope.workspaceId
  ) {
    throw new DooersThreadsClientError('SCOPE_MISMATCH', 'Conversation belongs to another session')
  }
  const state = snapshot.threads[threadId]
  if (!state?.thread) return null
  const thread = state.thread
  if (
    thread.threadId !== threadId ||
    thread.mode !== 'dooers_threads' ||
    thread.organizationId !== scope.organizationId ||
    thread.workspaceId !== scope.workspaceId
  ) {
    throw new DooersThreadsClientError('SCOPE_MISMATCH', 'Conversation authority or scope mismatch')
  }
  if (
    state.phase === 'revoked' ||
    !thread.permissions.read ||
    thread.state === 'deleted' ||
    thread.state === 'deleting'
  )
    return null
  const deliveries = Object.values(state.deliveriesById).map(toDooersThreadsDeliveryPresentation)
  const executions = Object.values(state.executionsById).map(toDooersThreadsExecutionPresentation)
  const textBlockReason =
    thread.state !== 'active'
      ? 'archived'
      : !thread.permissions.write
        ? 'read_only'
        : !hasDooersThreadsCapability(thread.capabilities, 'messages.text') ||
            !hasDooersThreadsCapability(connection.capabilities, 'messages.text')
          ? 'unsupported'
          : connection.status !== 'connected' || state.phase === 'disconnected'
            ? 'disconnected'
            : state.phase === 'failed'
              ? 'unavailable'
              : ['subscribing', 'replaying', 'resync'].includes(state.phase)
                ? 'recovering'
                : null
  return {
    authority: 'dooers_threads' as const,
    key: dooersThreadsPresentationKey(scope, threadId),
    scope: { ...scope },
    thread,
    participants: Object.values(state.participantsById),
    events: state.eventIds
      .map((id) => state.eventsById[id])
      .filter((item): item is DooersThreadsNetworkEvent => !!item)
      .map(eventPresentation)
      .sort((left, right) => compareDooersThreadsSequences(left.sequence, right.sequence)),
    deliveries,
    executions,
    // Commands are separate from persisted events, even when the ACK arrived first.
    publications: Object.values(state.commandsByKey).map((command) => ({
      threadId: command.threadId,
      clientEventId: command.clientEventId,
      state: command.state,
      result: command.result
        ? {
            eventId: command.result.eventId,
            cursor: command.result.cursor,
            duplicate: command.result.duplicate,
          }
        : null,
      errorCode: command.error?.code ?? null,
      draft: state.optimisticByKey[command.clientEventId] ?? null,
    })),
    permissions: { ...thread.permissions },
    capabilities: [...thread.capabilities],
    textAction: { enabled: textBlockReason === null, reason: textBlockReason },
    hasPendingWork: deliveries.some(
      (item) =>
        ['waiting_broker', 'pending', 'running', 'retry_wait'].includes(item.state) &&
        !executions.some(
          (execution) =>
            execution.executionId === item.executionId &&
            execution.deliveryId === item.deliveryId &&
            execution.participantId === item.participantId &&
            execution.state !== 'running'
        )
    ),
    waitingForInput: deliveries.some((item) => item.state === 'waiting_input'),
    resumeCursor: state.resumeCursor,
    beforeCursor: state.beforeCursor,
    appliedSequence: state.appliedSequence,
    phase: state.phase,
  }
}
export type DooersThreadsConversationPresentation = NonNullable<
  ReturnType<typeof toDooersThreadsConversationPresentation>
>
export type DooersThreadsDeliveryPresentation = ReturnType<
  typeof toDooersThreadsDeliveryPresentation
>
export type DooersThreadsExecutionPresentation = ReturnType<
  typeof toDooersThreadsExecutionPresentation
>
