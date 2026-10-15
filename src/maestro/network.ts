import { z } from 'zod'
import { MaestroContractError, toMaestroEvent } from '../protocol/maestro/contracts.js'
import {
  durableEventSchemas,
  publicSchemas,
  wsFrameSchemas,
} from '../protocol/maestro/vendor/public.js'

const registry: Readonly<Record<string, z.ZodType>> = publicSchemas
type Removal = { path: PropertyKey[]; keys: string[] }

// Only additional fields may be ignored. A union branch must otherwise be valid;
// never remove a known field to make a different union branch fit.
function additions(issues: readonly z.core.$ZodIssue[]): Removal[] | null {
  const result: Removal[] = []
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') result.push({ path: issue.path, keys: issue.keys })
    else if (issue.code === 'invalid_union') {
      const branch = issue.errors.map(additions).find((candidate) => candidate !== null)
      if (!branch) return null
      result.push(...branch.map((item) => ({ ...item, path: [...issue.path, ...item.path] })))
    } else return null
  }
  return result
}

/** Receive-side compatibility, derived from the frozen validator. Commands stay strict. */
export function parseMaestroNetwork<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  let candidate = value
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = schema.safeParse(candidate)
    if (result.success) return result.data
    const remove = additions(result.error.issues)
    if (!remove?.length) break
    candidate = structuredClone(candidate)
    for (const item of remove) {
      let parent = candidate
      for (const key of item.path) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) {
          parent = null
          break
        }
        parent = Reflect.get(parent, key)
      }
      if (parent && typeof parent === 'object')
        for (const key of item.keys) Reflect.deleteProperty(parent, key)
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
export function readMaestroNetworkEvent(value: unknown) {
  const type = value && typeof value === 'object' && 'type' in value ? value.type : null
  if (typeof type !== 'string') throw new MaestroContractError('event')
  const schema = Object.hasOwn(durableEventSchemas, type)
    ? durableEventSchemas[type as keyof typeof durableEventSchemas]
    : null
  return schema
    ? { known: true as const, event: parseMaestroNetwork(schema, value) }
    : { known: false as const, event: parseMaestroNetwork(futureEvent, value) }
}

export type MaestroUnknownEvent = Omit<
  import('../protocol/maestro/contracts.js').MaestroEvent,
  'type' | 'payload'
> & { type: string; payload: unknown }
export type MaestroNetworkEvent =
  | { known: true; event: import('../protocol/maestro/contracts.js').MaestroEvent }
  | { known: false; event: MaestroUnknownEvent }
export interface MaestroNetworkPage {
  items: MaestroNetworkEvent[]
  nextCursor: string | null
  hasMore: boolean
  watermark: string
}
export function toMaestroNetworkEvent(value: unknown): MaestroNetworkEvent {
  const parsed = readMaestroNetworkEvent(value)
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
      ? { ...commonActor, kind: actor.kind, instanceAgentId: actor.instance_agent_id }
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
export function readMaestroNetworkPage(value: unknown): MaestroNetworkPage {
  const schema = publicSchemas['Public.EventPage'].extend({ items: z.array(z.unknown()).max(100) })
  const page = parseMaestroNetwork(schema, value)
  return {
    items: page.items.map(toMaestroNetworkEvent),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
    watermark: page.watermark,
  }
}
/** Only event payload alternatives are extended; frame metadata stays frozen. */
export function readMaestroReplayFrame(type: 'thread.snapshot' | 'thread.replay', value: unknown) {
  const schema = wsFrameSchemas[type]!
  const frame = parseMaestroNetwork(
    schema.extend({
      payload: schema.shape.payload.extend({ events: z.array(z.unknown()).max(100) }),
    }),
    value
  )
  for (const event of frame.payload.events) readMaestroNetworkEvent(event)
  return frame
}
