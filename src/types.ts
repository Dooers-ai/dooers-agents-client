// --- Public types (camelCase) ---

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  url: string
  mimeType?: string
  alt?: string
}

export interface DocumentPart {
  type: 'document'
  url: string
  filename: string
  mimeType: string
}

export type ContentPart = TextPart | ImagePart | DocumentPart

export type Actor = 'user' | 'assistant' | 'system' | 'tool'
export type EventType =
  | 'message'
  | 'run.started'
  | 'run.finished'
  | 'tool.call'
  | 'tool.result'
  | 'tool.transaction'
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'canceled'
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface User {
  userId: string
  userName?: string | null
  userEmail?: string | null
  systemRole: string
  organizationRole: string
  workspaceRole: string
}

export interface Thread {
  id: string
  workerId: string
  organizationId: string
  workspaceId: string
  owner: User
  users: User[]
  title: string | null
  createdAt: string
  updatedAt: string
  lastEventAt: string
}

export interface ThreadEvent {
  id: string
  threadId: string
  runId: string | null
  type: EventType
  actor: Actor
  author: string | null
  user?: User
  content?: ContentPart[]
  data?: Record<string, unknown>
  createdAt: string
  clientEventId?: string
}

export interface Run {
  id: string
  threadId: string
  agentId: string | null
  status: RunStatus
  startedAt: string
  endedAt: string | null
  error: string | null
}

// --- Settings ---

export type SettingsFieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'checkbox'
  | 'textarea'
  | 'password'
  | 'email'
  | 'date'
  | 'image'

export interface SettingsSelectOption {
  value: string
  label: string
}

export interface SettingsField {
  id: string
  type: SettingsFieldType
  label: string
  required: boolean
  readonly: boolean
  value: unknown
  placeholder: string | null
  options: SettingsSelectOption[] | null
  min: number | null
  max: number | null
  rows: number | null
  src: string | null
  width: number | null
  height: number | null
}

export interface SettingsFieldGroup {
  id: string
  label: string
  fields: SettingsField[]
  collapsible: 'open' | 'closed' | null
}

export type SettingsItem = SettingsField | SettingsFieldGroup

export function isSettingsFieldGroup(item: SettingsItem): item is SettingsFieldGroup {
  return 'fields' in item && Array.isArray((item as SettingsFieldGroup).fields)
}

// --- Feedback ---

export type FeedbackType = 'like' | 'dislike'
export type FeedbackTarget = 'event' | 'run' | 'thread'

// --- Analytics ---

export interface AnalyticsEvent {
  event: string
  timestamp: string
  workerId: string
  threadId: string | null
  userId: string | null
  runId: string | null
  eventId: string | null
  data: Record<string, unknown> | null
}

export interface ThreadState {
  thread: Thread | null
  events: ThreadEvent[]
  runs: Run[]
  isLoading: boolean
  isWaiting: boolean
}

// --- Wire → Public transforms ---

import type {
  WireAnalyticsEvent,
  WireContentPart,
  WireRun,
  WireSettingsField,
  WireSettingsFieldGroup,
  WireSettingsItem,
  WireThread,
  WireThreadEvent,
  WireUser,
} from './protocol/models'

export function toUser(w: WireUser): User
export function toUser(w: WireUser | undefined): User | undefined
export function toUser(w?: WireUser): User | undefined {
  if (!w) return undefined
  return {
    userId: w.user_id,
    userName: w.user_name,
    userEmail: w.user_email,
    systemRole: w.system_role,
    organizationRole: w.organization_role,
    workspaceRole: w.workspace_role,
  }
}

export function toThread(w: WireThread): Thread {
  return {
    id: w.id,
    workerId: w.worker_id,
    organizationId: w.organization_id,
    workspaceId: w.workspace_id,
    owner: toUser(w.owner),
    users: w.users.map((u) => toUser(u)),
    title: w.title,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    lastEventAt: w.last_event_at,
  }
}

export function toContentPart(w: WireContentPart): ContentPart {
  switch (w.type) {
    case 'text':
      return { type: 'text', text: w.text }
    case 'image':
      return { type: 'image', url: w.url, mimeType: w.mime_type, alt: w.alt }
    case 'document':
      return { type: 'document', url: w.url, filename: w.filename, mimeType: w.mime_type }
  }
}

export function toThreadEvent(w: WireThreadEvent): ThreadEvent {
  return {
    id: w.id,
    threadId: w.thread_id,
    runId: w.run_id,
    type: w.type,
    actor: w.actor,
    author: w.author,
    user: toUser(w.user),
    content: w.content?.map(toContentPart),
    data: w.data,
    createdAt: w.created_at,
    clientEventId: w.client_event_id,
  }
}

export function toRun(w: WireRun): Run {
  return {
    id: w.id,
    threadId: w.thread_id,
    agentId: w.agent_id,
    status: w.status,
    startedAt: w.started_at,
    endedAt: w.ended_at,
    error: w.error,
  }
}

// --- Settings transforms ---

export function toSettingsField(w: WireSettingsField): SettingsField {
  return {
    id: w.id,
    type: w.type as SettingsFieldType,
    label: w.label,
    required: w.required,
    readonly: w.readonly,
    value: w.value,
    placeholder: w.placeholder,
    options: w.options,
    min: w.min,
    max: w.max,
    rows: w.rows,
    src: w.src,
    width: w.width,
    height: w.height,
  }
}

export function toSettingsItem(w: WireSettingsItem): SettingsItem {
  if ('fields' in w && Array.isArray((w as WireSettingsFieldGroup).fields)) {
    const g = w as WireSettingsFieldGroup
    return {
      id: g.id,
      label: g.label,
      fields: g.fields.map(toSettingsField),
      collapsible: g.collapsible,
    }
  }
  return toSettingsField(w as WireSettingsField)
}

// --- Analytics transforms ---

export function toAnalyticsEvent(w: WireAnalyticsEvent): AnalyticsEvent {
  return {
    event: w.event,
    timestamp: w.timestamp,
    workerId: w.worker_id,
    threadId: w.thread_id,
    userId: w.user_id,
    runId: w.run_id,
    eventId: w.event_id,
    data: w.data,
  }
}

// --- Public → Wire transforms (for sending content) ---

export function toWireContentPart(p: ContentPart): WireContentPart {
  switch (p.type) {
    case 'text':
      return { type: 'text', text: p.text }
    case 'image':
      return { type: 'image', url: p.url, mime_type: p.mimeType, alt: p.alt }
    case 'document':
      return { type: 'document', url: p.url, filename: p.filename, mime_type: p.mimeType }
  }
}
