// Mapeamento puro Maestro → modelos legados do chat (Thread, ThreadEvent, Run, User).
// O chat existente continua renderizando só os tipos legados; nada aqui faz I/O.

import type { MaestroNetworkEvent } from './maestro/network'
import type { MaestroExecution } from './maestro/store'
import type { MaestroMessageContent } from './maestro/types'
import type { MaestroParticipant, MaestroThread } from './protocol/maestro/contracts'
import type {
  DisplayContentPart,
  Run,
  RunStatus,
  SendContentPart,
  Thread,
  ThreadEvent,
  User,
} from './types'

/** ``systemRole`` marcando um participante agente na lista legada ``Thread.users``. */
export const MAESTRO_AGENT_ROLE = 'agent'

/** Versão anunciada ao chat legado: habilita participantes/acesso (0.22), não habilita filas (0.24). */
export function maestroLegacyServerVersion(serverVersion: string | null | undefined): string {
  const suffix = (serverVersion ?? '').replace(/[^0-9A-Za-z.-]/g, '') || 'unknown'
  return `0.22.0+maestro.${suffix}`
}

/**
 * O Maestro guarda nomes genéricos ("Humano", "Agente"). A aplicação pode resolver o nome
 * real pelo id (pessoa: principal; agente: instância); sem resolução fica o nome do Maestro.
 */
export type MaestroNameResolver = (kind: 'human' | 'agent', id: string) => string | null | undefined

const named = (
  resolve: MaestroNameResolver | undefined,
  kind: 'human' | 'agent',
  id: string,
  fallback: string
) => resolve?.(kind, id)?.trim() || fallback

export function maestroParticipantToUser(
  participant: MaestroParticipant,
  resolve?: MaestroNameResolver
): User {
  const id = participant.kind === 'agent' ? participant.instanceAgentId : participant.principalId
  return {
    userId: id,
    userName: named(resolve, participant.kind, id, participant.displayName),
    userEmail: null,
    identityIds: [participant.principalId],
    systemRole: participant.kind === 'agent' ? MAESTRO_AGENT_ROLE : 'user',
    organizationRole:
      participant.kind === 'human' && participant.role === 'owner' ? 'owner' : 'member',
    workspaceRole: 'member',
  }
}

/** Um agente participa enquanto não foi removido; suspenso ainda vê a conversa. */
export function maestroThreadHasAgent(thread: MaestroThread, agentId: string): boolean {
  const id = agentId.toLowerCase()
  return thread.participants.some(
    (p) =>
      p.kind === 'agent' &&
      p.state !== 'removed' &&
      (p.instanceAgentId.toLowerCase() === id || p.principalId.toLowerCase() === id)
  )
}

export function maestroThreadToLegacy(
  thread: MaestroThread,
  agentId: string,
  resolve?: MaestroNameResolver
): Thread {
  const active = thread.participants.filter((p) => p.state !== 'removed')
  const owner =
    active.find((p) => p.kind === 'human' && p.role === 'owner') ??
    active.find((p) => p.kind === 'human') ??
    active[0]
  return {
    id: thread.threadId,
    agentId,
    organizationId: thread.organizationId,
    workspaceId: thread.workspaceId ?? '',
    owner: owner
      ? maestroParticipantToUser(owner, resolve)
      : { userId: '', systemRole: 'user', organizationRole: 'member', workspaceRole: 'member' },
    users: active.map((p) => maestroParticipantToUser(p, resolve)),
    title: thread.title || null,
    metadata: {
      authority: 'maestro',
      participants: active.map((p) => ({
        kind: p.kind,
        participantId: p.participantId,
        principalId: p.principalId,
        displayName: named(
          resolve,
          p.kind,
          p.kind === 'agent' ? p.instanceAgentId : p.principalId,
          p.displayName
        ),
        ...(p.kind === 'agent' ? { instanceAgentId: p.instanceAgentId } : {}),
      })),
    },
    queue: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastEventAt: thread.updatedAt,
    access: {
      read: thread.permissions.read,
      write: thread.permissions.write,
      manage: thread.permissions.manage,
    },
  }
}

type Actor = MaestroNetworkEvent['event']['actor']

function actorName(actor: Actor, resolve: MaestroNameResolver | undefined): string {
  if (actor.kind === 'agent')
    return named(resolve, 'agent', actor.instanceAgentId, actor.displayName)
  if (actor.kind === 'human') return named(resolve, 'human', actor.principalId, actor.displayName)
  return actor.displayName
}

function actorUser(actor: Actor, resolve: MaestroNameResolver | undefined): User | undefined {
  if (actor.kind !== 'human') return undefined
  return {
    userId: actor.principalId,
    userName: actorName(actor, resolve),
    userEmail: null,
    identityIds: [actor.principalId],
    systemRole: 'user',
    organizationRole: 'member',
    workspaceRole: 'member',
  }
}

function legacyActor(actor: Actor): ThreadEvent['actor'] {
  return actor.kind === 'human' ? 'user' : actor.kind === 'agent' ? 'assistant' : 'system'
}

function attachmentKind(mimeType: string | undefined): 'image' | 'audio' | 'document' {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('audio/')) return 'audio'
  return 'document'
}

export function maestroContentToDisplay(content: MaestroMessageContent): DisplayContentPart[] {
  return content.map((part): DisplayContentPart => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const kind = attachmentKind(part.mime_type)
    // A URL exige leitura autenticada pelo Maestro; o chat mostra o arquivo sem pré-visualização.
    if (kind === 'audio')
      return { type: 'audio', ...(part.mime_type ? { mimeType: part.mime_type } : {}) }
    if (kind === 'image')
      return {
        type: 'image',
        refId: part.artifact_id,
        ...(part.filename ? { filename: part.filename, alt: part.filename } : {}),
        ...(part.mime_type ? { mimeType: part.mime_type } : {}),
      }
    return {
      type: 'document',
      refId: part.artifact_id,
      ...(part.filename ? { filename: part.filename } : {}),
      ...(part.mime_type ? { mimeType: part.mime_type } : {}),
      ...(part.size_bytes !== undefined ? { sizeBytes: part.size_bytes } : {}),
    }
  })
}

/** Converte partes de envio legadas. Anexos usam ``refId`` = ``artifact_id`` do upload Maestro. */
export function legacyContentToMaestro(params: {
  text?: string
  content?: SendContentPart[]
}): MaestroMessageContent {
  const parts = params.content ?? [{ type: 'text' as const, text: params.text ?? '' }]
  const out: MaestroMessageContent = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.trim()) out.push({ type: 'text', text: part.text })
      continue
    }
    out.push({
      type: 'attachment',
      artifact_id: part.refId,
      ...(part.filename ? { filename: part.filename } : {}),
      ...(part.mimeType ? { mime_type: part.mimeType } : {}),
    })
  }
  return out
}

type FormField = {
  name: string
  label: string
  required: boolean
  type: string
  max_length?: number
  options?: { value: string; label: string }[]
}

/** Definição de formulário Maestro → ``data`` do evento ``form`` legado (formato wire). */
export function maestroFormToLegacyData(definition: {
  title: string
  fields: readonly FormField[]
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  definition.fields.forEach((field, order) => {
    const base = { name: field.name, label: field.label, order, required: field.required }
    if (field.type === 'text')
      elements.push(
        (field.max_length ?? 0) > 500
          ? { ...base, type: 'textarea_input' }
          : { ...base, type: 'text_input', input_type: 'text' }
      )
    else if (field.type === 'number')
      elements.push({ ...base, type: 'text_input', input_type: 'number' })
    else if (field.type === 'boolean')
      elements.push({
        ...base,
        required: false,
        type: 'checkbox_input',
        options: [{ value: 'true', label: field.label }],
      })
    else if (field.type === 'select')
      elements.push({ ...base, type: 'select_input', options: field.options ?? [] })
    // Campos de artefato não têm equivalente no formulário legado e ficam de fora.
  })
  return { message: definition.title, elements, size: 'medium' }
}

/** Valores do formulário legado → ``data`` de ``interaction.respond`` (submit). */
export function legacyFormValuesToMaestro(
  fields: readonly FormField[],
  values: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const field of fields) {
    const value = values[field.name]
    if (field.type === 'boolean') {
      out[field.name] = Array.isArray(value) ? value.includes('true') : value === true
      continue
    }
    if (value === undefined || value === null || value === '') {
      if (!field.required) continue
      out[field.name] = null
      continue
    }
    if (field.type === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
      out[field.name] = Number.isFinite(n) ? n : null
    } else if (field.type === 'text' || field.type === 'select') out[field.name] = String(value)
  }
  return out
}

/** Evento Maestro → evento legado exibível; ``null`` para eventos sem equivalente no chat. */
export function maestroEventToLegacy(
  item: MaestroNetworkEvent,
  resolve?: MaestroNameResolver
): ThreadEvent | null {
  if (!item.known) return null
  const e = item.event
  const base = {
    threadId: e.threadId,
    runId: e.executionId ?? null,
    actor: legacyActor(e.actor),
    author: e.actor.kind === 'human' ? null : actorName(e.actor, resolve),
    createdAt: e.createdAt,
  }
  const user = actorUser(e.actor, resolve)
  switch (e.type) {
    case 'message.created':
      return {
        ...base,
        id: e.eventId,
        type: 'message',
        ...(user ? { user } : {}),
        content: maestroContentToDisplay(e.payload.content),
        ...(e.payload.client_event_id ? { clientEventId: e.payload.client_event_id } : {}),
      }
    case 'interaction.created': {
      const interaction = e.payload.interaction
      if (interaction.definition.kind !== 'form') return null
      return {
        ...base,
        id: interaction.interaction_id,
        type: 'form',
        data: maestroFormToLegacyData(interaction.definition),
      }
    }
    case 'interaction.responded':
      if (e.payload.action !== 'submit' && e.payload.action !== 'cancel') return null
      return {
        ...base,
        id: e.eventId,
        type: 'form.response',
        ...(user ? { user } : {}),
        data: {
          form_event_id: e.payload.interaction_id,
          cancelled: e.payload.action === 'cancel',
          values: e.payload.shared_data,
        },
      }
    default:
      return null
  }
}

const runStatus: Record<MaestroExecution['state'], RunStatus> = {
  running: 'running',
  completed: 'succeeded',
  failed: 'failed',
  timed_out: 'failed',
  canceled: 'canceled',
  // Suspensa = aguardando pessoa; não deve manter o indicador de "digitando".
  suspended: 'succeeded',
}

export function maestroExecutionToRun(
  execution: MaestroExecution,
  threadId: string,
  agentId: string | null,
  startedAt: string
): Run {
  return {
    id: execution.execution_id,
    threadId,
    agentId,
    status: runStatus[execution.state],
    startedAt,
    endedAt: execution.completed_at ?? null,
    error:
      execution.state === 'failed' || execution.state === 'timed_out'
        ? (execution.reason_code ?? execution.state)
        : null,
  }
}
