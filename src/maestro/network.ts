import { z } from 'zod'
import { MaestroContractError, toMaestroEvent } from '../protocol/maestro/contracts.js'
import {
  durableEventSchemas,
  publicSchemas,
  wsFrameSchemas,
} from '../protocol/maestro/vendor/public.js'

const registry: Readonly<Record<string, z.ZodType>> = publicSchemas

/** What the receive layer dropped or could not interpret. Reported once per type by the client. */
export type MaestroUnsupportedKind = 'content_part' | 'form_field' | 'event'
export type MaestroUnsupportedReport = (kind: MaestroUnsupportedKind, type: string) => void

type Removal =
  | { path: PropertyKey[]; keys: string[] }
  | {
      path: PropertyKey[]
      discard: { kind: MaestroUnsupportedKind; type: string }
    }

// Arrays whose items are a discriminated union that newer Maestro contracts may extend.
const extensibleArrays: Readonly<Record<string, MaestroUnsupportedKind>> = {
  content: 'content_part',
  fields: 'form_field',
}

function at(root: unknown, path: readonly PropertyKey[]): unknown {
  let node = root
  for (const key of path) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined
    node = Reflect.get(node, key)
  }
  return node
}

// Only additional fields and unknown members of an extensible union may be ignored. Every other
// union branch must be valid; never remove a known field to make a different branch fit.
function additions(
  issues: readonly z.core.$ZodIssue[],
  root: unknown,
  prefix: PropertyKey[] = []
): Removal[] | null {
  const result: Removal[] = []
  for (const issue of issues) {
    const path = [...prefix, ...issue.path]
    if (issue.code === 'unrecognized_keys') result.push({ path, keys: issue.keys })
    else if (issue.code === 'invalid_union') {
      if (
        issue.errors.length === 0 &&
        'note' in issue &&
        issue.note === 'No matching discriminator'
      ) {
        // The issue path ends at the discriminator key; the unknown member is its parent.
        const member = path.slice(0, -1)
        const index = member.at(-1)
        const owner = member.at(-2)
        const kind = typeof owner === 'string' ? extensibleArrays[owner] : undefined
        const value = at(root, member)
        const type =
          value && typeof value === 'object' && !Array.isArray(value)
            ? Reflect.get(value, 'type')
            : undefined
        if (
          !kind ||
          typeof index !== 'number' ||
          path.at(-1) !== 'type' ||
          typeof type !== 'string' ||
          !Array.isArray(at(root, member.slice(0, -1)))
        )
          return null
        result.push({ path: member, discard: { kind, type } })
        continue
      }
      const branch = issue.errors
        .map((errors) => additions(errors, root, path))
        .find((candidate) => candidate !== null)
      if (!branch) return null
      result.push(...branch)
    } else return null
  }
  return result
}

/** Descending order, so removing array items never shifts an item still to be removed. */
function descending(left: PropertyKey[], right: PropertyKey[]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue
    return Number(right[i]) - Number(left[i]) || String(right[i]).localeCompare(String(left[i]))
  }
  return right.length - left.length
}

/**
 * Receive-side compatibility, derived from the frozen validator. Commands stay strict.
 * Unknown content parts and form fields are dropped (and reported) so that the known ones survive.
 */
export function parseMaestroNetwork<T extends z.ZodType>(
  schema: T,
  value: unknown,
  onUnsupported?: MaestroUnsupportedReport
): z.output<T> {
  let candidate = value
  const dropped = new Map<string, { kind: MaestroUnsupportedKind; type: string }>()
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = schema.safeParse(candidate)
    if (result.success) {
      for (const { kind, type } of dropped.values()) onUnsupported?.(kind, type)
      return result.data
    }
    const remove = additions(result.error.issues, candidate)
    if (!remove?.length) break
    candidate = structuredClone(candidate)
    for (const item of remove) {
      if (!('keys' in item)) continue
      const parent = at(candidate, item.path)
      if (parent && typeof parent === 'object')
        for (const key of item.keys) Reflect.deleteProperty(parent, key)
    }
    const discards = remove
      .filter((item): item is Extract<Removal, { discard: unknown }> => 'discard' in item)
      .filter(
        (item, i, all) => all.findIndex((other) => other.path.join() === item.path.join()) === i
      )
      .sort((a, b) => descending(a.path, b.path))
    for (const { path, discard } of discards) {
      const list = at(candidate, path.slice(0, -1))
      if (!Array.isArray(list)) continue
      list.splice(Number(path.at(-1)), 1)
      dropped.set(`${discard.kind}:${discard.type}`, discard)
    }
  }
  throw new MaestroContractError('network response')
}

export function parseMaestroNetworkSchema(name: string, value: unknown): unknown {
  const schema = Object.hasOwn(registry, name) ? registry[name] : undefined
  if (!schema) throw new MaestroContractError('network response')
  return parseMaestroNetwork(schema, value)
}

const futureEvent = durableEventSchemas['message.created']
  .omit({ type: true, payload: true })
  .extend({
    type: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    payload: z.unknown(),
  })

/** A future event is display data only, never a capability or command confirmation. */
export function readMaestroNetworkEvent(value: unknown, onUnsupported?: MaestroUnsupportedReport) {
  const type = value && typeof value === 'object' && 'type' in value ? value.type : null
  if (typeof type !== 'string') throw new MaestroContractError('event')
  const schema = Object.hasOwn(durableEventSchemas, type)
    ? durableEventSchemas[type as keyof typeof durableEventSchemas]
    : null
  if (schema)
    return {
      known: true as const,
      event: parseMaestroNetwork(schema, value, onUnsupported),
    }
  const future = parseMaestroNetwork(futureEvent, value)
  onUnsupported?.('event', future.type)
  return { known: false as const, event: future }
}

export type MaestroUnknownEvent = Omit<
  import('../protocol/maestro/contracts.js').MaestroEvent,
  'type' | 'payload'
> & { type: string; payload: unknown }
export type MaestroNetworkEvent =
  | {
      known: true
      event: import('../protocol/maestro/contracts.js').MaestroEvent
    }
  | { known: false; event: MaestroUnknownEvent }
export interface MaestroNetworkPage {
  items: MaestroNetworkEvent[]
  nextCursor: string | null
  hasMore: boolean
  watermark: string
}
export function toMaestroNetworkEvent(
  value: unknown,
  onUnsupported?: MaestroUnsupportedReport
): MaestroNetworkEvent {
  const parsed = readMaestroNetworkEvent(value, onUnsupported)
  if (parsed.known) return { known: true, event: toMaestroEvent(parsed.event) }
  const e = parsed.event
  const actor = e.actor
  const commonActor = {
    principalId: actor.principal_id,
    participantId: actor.participant_id,
    displayName: actor.display_name,
  }
  const publicActor =
    actor.kind === 'agent'
      ? {
          ...commonActor,
          kind: actor.kind,
          instanceAgentId: actor.instance_agent_id,
        }
      : { ...commonActor, kind: actor.kind }
  return {
    known: false,
    event: {
      eventId: e.event_id,
      threadId: e.thread_id,
      sequence: e.sequence,
      type: e.type,
      schemaVersion: e.schema_version,
      actor: publicActor,
      payload: e.payload,
      createdAt: e.created_at,
      causationEventId: e.causation_event_id,
      rootEventId: e.root_event_id,
      ...(e.delivery_id ? { deliveryId: e.delivery_id } : {}),
      ...(e.execution_id ? { executionId: e.execution_id } : {}),
      ...(e.output_id ? { outputId: e.output_id } : {}),
    },
  }
}
export function readMaestroNetworkPage(
  value: unknown,
  onUnsupported?: MaestroUnsupportedReport
): MaestroNetworkPage {
  const schema = publicSchemas['Public.EventPage'].extend({
    items: z.array(z.unknown()).max(100),
  })
  const page = parseMaestroNetwork(schema, value)
  return {
    items: page.items.map((item) => toMaestroNetworkEvent(item, onUnsupported)),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
    watermark: page.watermark,
  }
}
/** Only event payload alternatives are extended; frame metadata stays frozen. */
export function readMaestroReplayFrame(
  type: 'thread.snapshot' | 'thread.replay',
  value: unknown,
  onUnsupported?: MaestroUnsupportedReport
) {
  const schema = wsFrameSchemas[type]!
  const frame = parseMaestroNetwork(
    schema.extend({
      payload: schema.shape.payload.extend({
        events: z.array(z.unknown()).max(100),
      }),
    }),
    value
  )
  for (const event of frame.payload.events) readMaestroNetworkEvent(event, onUnsupported)
  return frame
}
