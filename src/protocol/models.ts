// Wire format types — snake_case, matching the server's JSON exactly.
// These are internal. Public types in types.ts use camelCase.

export interface WireUser {
  user_id: string
  user_name?: string | null
  user_email?: string | null
  identity_ids?: string[]
  system_role: string
  organization_role: string
  workspace_role: string
}

export interface WireThread {
  id: string
  agent_id: string
  organization_id: string
  workspace_id: string
  owner: WireUser
  users: WireUser[]
  title: string | null
  created_at: string
  updated_at: string
  last_event_at: string
}

// --- C2S wire format (ref_id for uploads) ---

export interface WireC2S_TextPart {
  type: 'text'
  text: string
}

export interface WireC2S_AudioPart {
  type: 'audio'
  ref_id: string
  duration?: number
  url?: string | null
}

export interface WireC2S_ImagePart {
  type: 'image'
  ref_id: string
  url?: string | null
}

export interface WireC2S_DocumentPart {
  type: 'document'
  ref_id: string
  url?: string | null
}

export type WireC2S_ContentPart =
  | WireC2S_TextPart
  | WireC2S_AudioPart
  | WireC2S_ImagePart
  | WireC2S_DocumentPart

// --- S2C wire format (URLs/metadata from server) ---

export interface WireS2C_TextPart {
  type: 'text'
  text: string
}

export interface WireS2C_AudioPart {
  type: 'audio'
  url?: string
  mime_type?: string
  duration?: number
  filename?: string
}

export interface WireS2C_ImagePart {
  type: 'image'
  url?: string
  mime_type?: string
  width?: number
  height?: number
  alt?: string
  filename?: string
}

export interface WireS2C_DocumentPart {
  type: 'document'
  url?: string
  filename?: string
  mime_type?: string
  size_bytes?: number
}

export type WireS2C_ContentPart =
  | WireS2C_TextPart
  | WireS2C_AudioPart
  | WireS2C_ImagePart
  | WireS2C_DocumentPart

// Backward-compatible alias
export type WireContentPart = WireS2C_ContentPart

// --- Wire S2C form elements (content parts for form events) ---

export interface WireFormOption {
  value: string
  label: string
}

export interface WireS2C_FormTextElement {
  type: 'text_input'
  name: string
  label: string
  order?: number
  required?: boolean
  disabled?: boolean
  placeholder?: string | null
  default?: string | null
  input_type?: 'text' | 'password' | 'email' | 'number'
}

export interface WireS2C_FormTextareaElement {
  type: 'textarea_input'
  name: string
  label: string
  order?: number
  required?: boolean
  disabled?: boolean
  placeholder?: string | null
  default?: string | null
  rows?: number | null
}

export interface WireS2C_FormSelectElement {
  type: 'select_input'
  name: string
  label: string
  options: WireFormOption[]
  order?: number
  required?: boolean
  disabled?: boolean
  default?: string | null
  placeholder?: string | null
}

export interface WireS2C_FormRadioElement {
  type: 'radio_input'
  name: string
  label: string
  options: WireFormOption[]
  order?: number
  required?: boolean
  disabled?: boolean
  default?: string | null
  variant?: 'native' | 'button'
}

export interface WireS2C_FormCheckboxElement {
  type: 'checkbox_input'
  name: string
  label: string
  options: WireFormOption[]
  order?: number
  required?: boolean
  disabled?: boolean
  default?: string[] | null
  variant?: 'native' | 'button'
}

export interface WireS2C_FormFileElement {
  type: 'file_input'
  name: string
  label: string
  upload_url: string
  order?: number
  required?: boolean
  disabled?: boolean
  accept?: string | null
  multiple?: boolean
}

export type WireS2C_FormElement =
  | WireS2C_FormTextElement
  | WireS2C_FormTextareaElement
  | WireS2C_FormSelectElement
  | WireS2C_FormRadioElement
  | WireS2C_FormCheckboxElement
  | WireS2C_FormFileElement

export type WireActor = 'user' | 'assistant' | 'system' | 'tool'
export type WireEventType =
  | 'message'
  | 'run.started'
  | 'run.finished'
  | 'tool.call'
  | 'tool.result'
  | 'tool.transaction'
  | 'form'
  | 'form.response'
export type WireRunStatus = 'running' | 'succeeded' | 'failed' | 'canceled'

export interface WireThreadEvent {
  id: string
  thread_id: string
  run_id: string | null
  type: WireEventType
  actor: WireActor
  author: string | null
  user?: WireUser
  content?: WireS2C_ContentPart[]
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
  /** When false, user audience cannot patch (template-fixed at worker). */
  user_editable?: boolean
  visibility?: 'internal' | 'creator' | 'user'
  value: unknown
  placeholder: string | null
  options: WireSettingsSelectOption[] | null
  min: number | null
  max: number | null
  rows: number | null
  src: string | null
  width: number | null
  height: number | null
  upload_url: string | null
  accept: string | null
}

export interface WireSettingsFieldGroup {
  id: string
  label: string
  fields: WireSettingsField[]
  collapsible: 'open' | 'closed' | null
  visibility?: 'internal' | 'creator' | 'user'
}

export type WireSettingsItem = WireSettingsField | WireSettingsFieldGroup

// --- Analytics ---

export interface WireAnalyticsEvent {
  event: string
  timestamp: string
  agent_id: string
  thread_id: string | null
  user_id: string | null
  run_id: string | null
  event_id: string | null
  data: Record<string, unknown> | null
}
