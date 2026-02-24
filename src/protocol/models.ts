// Wire format types — snake_case, matching the server's JSON exactly.
// These are internal. Public types in types.ts use camelCase.

export interface WireUser {
  user_id: string
  user_name?: string | null
  user_email?: string | null
  system_role: string
  organization_role: string
  workspace_role: string
}

export interface WireThread {
  id: string
  worker_id: string
  organization_id: string
  workspace_id: string
  owner: WireUser
  users: WireUser[]
  title: string | null
  created_at: string
  updated_at: string
  last_event_at: string
}

export interface WireTextPart {
  type: 'text'
  text: string
}

export interface WireImagePart {
  type: 'image'
  url: string
  mime_type?: string
  width?: number
  height?: number
  alt?: string
}

export interface WireDocumentPart {
  type: 'document'
  url: string
  filename: string
  mime_type: string
  size_bytes?: number
}

export type WireContentPart = WireTextPart | WireImagePart | WireDocumentPart

export type WireActor = 'user' | 'assistant' | 'system' | 'tool'
export type WireEventType =
  | 'message'
  | 'run.started'
  | 'run.finished'
  | 'tool.call'
  | 'tool.result'
  | 'tool.transaction'
export type WireRunStatus = 'running' | 'succeeded' | 'failed' | 'canceled'

export interface WireThreadEvent {
  id: string
  thread_id: string
  run_id: string | null
  type: WireEventType
  actor: WireActor
  author: string | null
  user?: WireUser
  content?: WireContentPart[]
  data?: Record<string, unknown>
  created_at: string
  streaming?: boolean
  finalized?: boolean
  client_event_id?: string
}

export interface WireRun {
  id: string
  thread_id: string
  agent_id: string | null
  status: WireRunStatus
  started_at: string
  ended_at: string | null
  error: string | null
}

// --- Settings ---

export interface WireSettingsSelectOption {
  value: string
  label: string
}

export interface WireSettingsField {
  id: string
  type: string
  label: string
  required: boolean
  readonly: boolean
  value: unknown
  placeholder: string | null
  options: WireSettingsSelectOption[] | null
  min: number | null
  max: number | null
  rows: number | null
  src: string | null
  width: number | null
  height: number | null
}

export interface WireSettingsFieldGroup {
  id: string
  label: string
  fields: WireSettingsField[]
  collapsible: 'open' | 'closed' | null
}

export type WireSettingsItem = WireSettingsField | WireSettingsFieldGroup

// --- Analytics ---

export interface WireAnalyticsEvent {
  event: string
  timestamp: string
  worker_id: string
  thread_id: string | null
  user_id: string | null
  run_id: string | null
  event_id: string | null
  data: Record<string, unknown> | null
}
