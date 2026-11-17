// Mapeamento puro Maestro → modelos legados do chat (Thread, ThreadEvent, Run, User).
// O chat existente continua renderizando só os tipos legados; nada aqui faz I/O.

import type { MaestroNetworkEvent } from './maestro/network'
import type { MaestroMessageContent } from './maestro/types'
import {
  compareMaestroSequences,
  type MaestroEvent,
  type MaestroParticipant,
  type MaestroThread,
} from './protocol/maestro/contracts'
import type { WireS2C_ContentPart } from './protocol/models'
import {
  type DisplayContentPart,
  type Run,
  type SendContentPart,
  type Thread,
  type ThreadEvent,
  toDisplayContentPart,
  type User,
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

/**
 * A contact of a messaging channel (WhatsApp number, public-chat visitor) has no Dooers principal.
 * Production keeps it as a plain user whose id is the channel id (``User(user_id=<e164>)``).
 */
function externalUser(contact: { externalId: string; displayName?: string }): User {
  return {
    userId: contact.externalId,
    userName: contact.displayName ?? contact.externalId,
    userEmail: null,
    identityIds: [],
    systemRole: 'user',
    organizationRole: 'member',
    workspaceRole: 'member',
  }
}

/** The id the legacy views show: the instance agent id, the principal, or the contact channel id. */
export function maestroParticipantLegacyId(participant: MaestroParticipant): string {
  if (participant.kind === 'agent') return participant.instanceAgentId
  return participant.kind === 'external' ? participant.externalId : participant.principalId
}

export function maestroParticipantToUser(
  participant: MaestroParticipant,
  resolve?: MaestroNameResolver
): User {
  if (participant.kind === 'external') return externalUser(participant)
  const id = maestroParticipantLegacyId(participant)
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
      state: thread.state,
      participants: active.map((p) =>
        p.kind === 'external'
          ? {
              kind: p.kind,
              participantId: p.participantId,
              externalId: p.externalId,
              channel: p.channel,
              displayName: p.displayName ?? p.externalId,
            }
          : {
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
            }
      ),
      // Production has no channel on the wire Thread; the chat finds it here (WhatsApp, public chat).
      channel: thread.channel ?? 'dooers-platform',
      ...(thread.channelMeta ? { channelMeta: thread.channelMeta } : {}),
    },
    queue: thread.queue ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastEventAt: thread.updatedAt,
    access: {
      read: thread.permissions.read,
      write: thread.permissions.write,
      manage: thread.permissions.manage,
      archive: thread.permissions.archive,
      removeParticipants: thread.permissions.remove_participants,
      assignOwner: thread.permissions.assign_owner === true,
    },
  }
}

type Actor = MaestroNetworkEvent['event']['actor']

function actorName(actor: Actor, resolve: MaestroNameResolver | undefined): string {
  if (actor.kind === 'agent')
    return named(resolve, 'agent', actor.instanceAgentId, actor.displayName)
  if (actor.kind === 'human') return named(resolve, 'human', actor.principalId, actor.displayName)
  if (actor.kind === 'external') return actor.displayName ?? actor.externalId
  return actor.displayName
}

/** The agent behind an event: its principal id and, when the resolver knows it, its platform name. */
function actorAgent(
  actor: Actor,
  resolve: MaestroNameResolver | undefined
): ThreadEvent['agent'] | undefined {
  if (actor.kind !== 'agent') return undefined
  const name =
    resolve?.('agent', actor.principalId)?.trim() ||
    resolve?.('agent', actor.instanceAgentId)?.trim()
  return { id: actor.principalId, ...(name ? { name } : {}) }
}

function actorUser(actor: Actor, resolve: MaestroNameResolver | undefined): User | undefined {
  if (actor.kind === 'external') return externalUser(actor)
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

/** A person, Dooers user or external contact, is ``user`` in production; the agent is ``assistant``. */
function legacyActor(actor: Actor): ThreadEvent['actor'] {
  return actor.kind === 'human' || actor.kind === 'external'
    ? 'user'
    : actor.kind === 'agent'
      ? 'assistant'
      : 'system'
}

function attachmentKind(mimeType: string | undefined): 'image' | 'audio' | 'document' {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('audio/')) return 'audio'
  return 'document'
}

/** Every part of a stored message: the human parts plus the agent-only ``media_link``. */
export type MaestroEventContent = Extract<
  MaestroEvent,
  { type: 'message.created' }
>['payload']['content']
type MediaLinkPart = Extract<MaestroEventContent[number], { type: 'media_link' }>
type ContactPart = Extract<MaestroEventContent[number], { type: 'contact' }>

/**
 * The production image, audio or document part the agent did not upload (``media_link``): the same wire part
 * (``WireS2C_*Part``), shown with the production conversion. The URL, the ``ref_id`` and the metadata go as the
 * agent wrote them; a part with only a ``ref_id`` opens by it, as in production.
 */
function mediaLinkToDisplay(part: MediaLinkPart): DisplayContentPart {
  const { type: _type, kind, ...fields } = part
  return toDisplayContentPart({ ...fields, type: kind } as WireS2C_ContentPart)
}

/**
 * The contact part of the production wire (``WireS2C_ContactPart``: ``phones`` defaults to ``[]``).
 * ``DisplayContentPart`` has no contact member (the production client does not render contacts);
 * the chat skips parts whose type it does not know, so the value passes through as on the wire.
 */
function contactToDisplay(part: ContactPart): DisplayContentPart {
  const wire = {
    type: 'contact' as const,
    display_name: part.display_name,
    ...(part.vcard !== undefined ? { vcard: part.vcard } : {}),
    phones: part.phones ?? [],
  }
  return wire as unknown as DisplayContentPart
}

export function maestroContentToDisplay(
  content: MaestroEventContent | MaestroMessageContent
): DisplayContentPart[] {
  return content.map((part): DisplayContentPart => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'media_link') return mediaLinkToDisplay(part)
    if (part.type === 'contact') return contactToDisplay(part)
    const kind = attachmentKind(part.mime_type)
    // Sem URL: o chat abre o arquivo pelo hook de artefato (leitura autenticada) usando ``refId``.
    if (kind === 'audio')
      return {
        type: 'audio',
        refId: part.artifact_id,
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.mime_type ? { mimeType: part.mime_type } : {}),
        ...(part.size_bytes !== undefined ? { sizeBytes: part.size_bytes } : {}),
        ...(part.duration !== undefined ? { duration: part.duration } : {}),
      }
    if (kind === 'image')
      return {
        type: 'image',
        refId: part.artifact_id,
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.mime_type ? { mimeType: part.mime_type } : {}),
        ...(part.alt ? { alt: part.alt } : {}),
        ...(part.width !== undefined ? { width: part.width } : {}),
        ...(part.height !== undefined ? { height: part.height } : {}),
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

// --- Fold: edits, removals, delivery status and run ids that later events apply to earlier ones ---

type Payload<T extends MaestroEvent['type']> = Extract<MaestroEvent, { type: T }>['payload']

/** State a later event gives to an earlier one. It never comes from the wire of the event itself. */
export interface MaestroFold {
  /** ``data.delivery`` of production: the WhatsApp route of the message plus its latest status. */
  delivery?: Record<string, unknown>
  /** Run that this event (a person's message or form response) opened: production sets its run_id. */
  runId?: string
}
export type MaestroFoldedEvent = MaestroEvent & { fold?: MaestroFold }

/** ``_STATUS_RANK`` of production (delivery_receipt.py): a late webhook never walks the status back. */
const DELIVERY_RANK: Readonly<Record<string, number>> = {
  accepted: 1,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
}

/** ``_receipt_moves_forward`` of production: ``failed`` is final; an equal rank still applies. */
function deliveryMovesForward(current: unknown, incoming: string): boolean {
  if (current === 'failed') return false
  if (incoming === 'failed') return true
  const rank = DELIVERY_RANK[incoming]
  if (rank === undefined) return false
  return rank >= (typeof current === 'string' ? (DELIVERY_RANK[current] ?? 0) : 0)
}

/** Production ``data.delivery`` of an agent message: the route (``_assistant_delivery_data``) plus each status that moved forward. */
function foldDelivery(
  route: Payload<'message.created'>['whatsapp'],
  updates: readonly Payload<'channel_delivery.updated'>[]
): Record<string, unknown> | undefined {
  if (!route && !updates.length) return undefined
  let delivery: Record<string, unknown> = route
    ? { channel: 'whatsapp', to_e164: route.to_e164, instance_id: route.instance_id }
    : {}
  for (const update of updates) {
    if (!deliveryMovesForward(delivery.status, update.status)) continue
    delivery = {
      ...delivery,
      status: update.status,
      ...(update.provider_message_id ? { wa_message_id: update.provider_message_id } : {}),
      ...(update.error?.trim() ? { error_message: update.error.trim().slice(0, 500) } : {}),
    }
  }
  return delivery
}

const bySequence = (left: MaestroEvent, right: MaestroEvent) =>
  compareMaestroSequences(left.sequence, right.sequence)

/**
 * Applies ``message.updated`` and ``message.removed`` to their target event, and keeps
 * ``channel_delivery.updated`` (only when the status moves forward) and the run id of
 * ``run.updated.trigger_event_id`` on the target. Later events win (by sequence), whatever order
 * they arrive in: an edit read before its original still applies when the original arrives.
 * The three control events leave the list; every other event keeps its place.
 */
export function foldMaestroEvents(events: readonly MaestroEvent[]): MaestroFoldedEvent[] {
  const removed = new Set<string>()
  const edits = new Map<string, Payload<'message.updated'>['content']>()
  const deliveries = new Map<string, Payload<'channel_delivery.updated'>[]>()
  const runs = new Map<string, string>()
  for (const event of [...events].sort(bySequence)) {
    if (event.type === 'message.removed') removed.add(event.payload.event_id)
    else if (event.type === 'message.updated')
      edits.set(event.payload.event_id, event.payload.content)
    else if (event.type === 'channel_delivery.updated')
      deliveries.set(event.payload.event_id, [
        ...(deliveries.get(event.payload.event_id) ?? []),
        event.payload,
      ])
    else if (event.type === 'run.updated')
      runs.set(event.payload.trigger_event_id, event.payload.run_id)
  }
  const out: MaestroFoldedEvent[] = []
  for (const event of events) {
    if (
      event.type === 'message.updated' ||
      event.type === 'message.removed' ||
      event.type === 'channel_delivery.updated' ||
      removed.has(event.eventId)
    )
      continue
    const runId = runs.get(event.eventId)
    if (event.type !== 'message.created') {
      out.push(runId ? { ...event, fold: { runId } } : event)
      continue
    }
    const content = edits.get(event.eventId)
    const delivery = foldDelivery(event.payload.whatsapp, deliveries.get(event.eventId) ?? [])
    const fold = { ...(delivery ? { delivery } : {}), ...(runId ? { runId } : {}) }
    out.push({
      ...event,
      ...(content ? { payload: { ...event.payload, content } } : {}),
      ...(delivery || runId ? { fold } : {}),
    })
  }
  return out
}

// --- Maestro event → production ThreadEvent (handlers/pipeline.py of the production server) ---

/** Production ``data.template`` of ``send.template``: ``{name, language, components}``. */
function templateData(template: NonNullable<Payload<'message.created'>['template']>) {
  return {
    name: template.template_name.trim(),
    language: template.template_language.trim(),
    components: template.template_components ?? [],
  }
}

/** The payload without ``run_id``: production keeps the run on the event, not in ``data``. */
function withoutRun<T extends { run_id?: string }>(payload: T): Omit<T, 'run_id'> {
  const { run_id: _run, ...data } = payload
  return data
}

/** Evento Maestro → evento legado exibível; ``null`` para eventos sem equivalente no chat. */
export function maestroEventToLegacy(
  item: MaestroNetworkEvent | { known: true; event: MaestroFoldedEvent },
  resolve?: MaestroNameResolver
): ThreadEvent | null {
  if (!item.known) return null
  const e = item.event
  const fold = 'fold' in e ? e.fold : undefined
  const payloadRun =
    'run_id' in e.payload && typeof e.payload.run_id === 'string' ? e.payload.run_id : undefined
  const person = legacyActor(e.actor) === 'user'
  const name = actorName(e.actor, resolve)
  const agent = actorAgent(e.actor, resolve)
  const base = {
    id: e.eventId,
    threadId: e.threadId,
    // Production sets the run id only where the handler called run_start; an execution id is not a run.
    runId: payloadRun ?? fold?.runId ?? null,
    actor: legacyActor(e.actor),
    author: person ? null : name,
    createdAt: e.createdAt,
    ...(agent ? { agent } : {}),
  }
  const user = actorUser(e.actor, resolve)
  switch (e.type) {
    case 'message.created': {
      const p = e.payload
      const data = {
        ...(fold?.delivery ? { delivery: fold.delivery } : {}),
        ...(p.template ? { template: templateData(p.template) } : {}),
      }
      return {
        ...base,
        type: 'message',
        // Production: ``event.data.get("author") or assistant_name``.
        author: person ? null : p.author || name,
        ...(user ? { user } : {}),
        content: maestroContentToDisplay(p.content),
        ...(Object.keys(data).length ? { data } : {}),
        ...(p.client_event_id ? { clientEventId: p.client_event_id } : {}),
      }
    }
    case 'reasoning.created':
      return {
        ...base,
        type: 'reasoning',
        author: e.payload.author || name,
        data: { text: e.payload.text },
      }
    case 'tool_call.created':
    case 'tool_transaction.created': {
      const p = e.payload
      // Production writes every key, None included, and no author.
      return {
        ...base,
        type: e.type === 'tool_call.created' ? 'tool.call' : 'tool.transaction',
        author: null,
        data: {
          id: p.id,
          name: p.name,
          display_name: p.display_name ?? null,
          args: p.args,
          ...('result' in p ? { result: p.result } : {}),
        },
      }
    }
    case 'tool_result.created': {
      const p = e.payload
      return {
        ...base,
        type: 'tool.result',
        actor: 'tool',
        author: null,
        data: {
          id: p.id,
          name: p.name,
          display_name: p.display_name ?? null,
          args: p.args ?? null,
          result: p.result,
        },
      }
    }
    case 'chart.created':
      // WireS2C_ChartEventData dumped with exclude_unset: send.chart always sets x_label and y_label.
      return {
        ...base,
        type: 'chart',
        data: {
          ...withoutRun(e.payload),
          x_label: e.payload.x_label ?? null,
          y_label: e.payload.y_label ?? null,
        },
      }
    case 'form.created':
      // Elements pass as they are: the 6 production element types and their variants.
      return { ...base, type: 'form', data: withoutRun(e.payload) }
    case 'form.responded':
      return {
        ...base,
        type: 'form.response',
        ...(user ? { user } : {}),
        data: {
          form_event_id: e.payload.form_event_id,
          cancelled: e.payload.cancelled,
          values: e.payload.values,
        },
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

/**
 * ``run.updated`` events → the production runs (``send.run_start``/``send.run_end``): one Run per
 * ``run_id`` with its latest status. ``startedAt`` is the ``running`` event, ``endedAt`` the end
 * event, ``agentId`` the agent the run started with.
 *
 * Strict parity with production: a run closes only through its own ``run.updated`` (``run_end``,
 * or the handler failure the server reports as ``failed``). The execution outcome never closes it,
 * so a run the agent left open stays ``running``, as ``pipeline.py`` leaves it.
 */
export function maestroRunsToLegacy(events: readonly MaestroEvent[]): Run[] {
  const runs = new Map<string, Run>()
  for (const event of [...events].sort(bySequence)) {
    if (event.type !== 'run.updated') continue
    const p = event.payload
    const previous = runs.get(p.run_id)
    runs.set(p.run_id, {
      id: p.run_id,
      threadId: event.threadId,
      agentId: previous?.agentId ?? p.agent_id,
      status: p.status,
      startedAt: previous?.startedAt ?? event.createdAt,
      endedAt: p.status === 'running' ? null : event.createdAt,
      error: p.error ?? null,
    })
  }
  return [...runs.values()]
}
