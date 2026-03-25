import type {
  WireAnalyticsEvent,
  WireC2S_ContentPart,
  WireRun,
  WireSettingsItem,
  WireThread,
  WireThreadEvent,
  WireUser,
} from './models'

// --- Frame wrapper ---

export interface Frame<T extends string, P = unknown> {
  id: string
  type: T
  payload: P
}

// --- Client to Server (C2S) ---

export type C2S_Connect = Frame<
  'connect',
  {
    worker_id: string
    organization_id: string
    workspace_id: string
    user: WireUser
    auth_token?: string
    client?: { name: string; version: string }
  }
>

export type C2S_ThreadList = Frame<'thread.list', { cursor?: string | null; limit?: number }>

export type C2S_ThreadSubscribe = Frame<
  'thread.subscribe',
  { thread_id: string; after_event_id?: string | null }
>

export type C2S_ThreadUnsubscribe = Frame<'thread.unsubscribe', { thread_id: string }>

export type C2S_ThreadDelete = Frame<'thread.delete', { thread_id: string }>

export type C2S_EventCreate = Frame<
  'event.create',
  {
    thread_id?: string
    client_event_id?: string
    event: {
      type: 'message'
      actor: 'user'
      content: WireC2S_ContentPart[]
      data?: Record<string, unknown>
    }
  }
>

// --- Event pagination C2S ---

export type C2S_EventList = Frame<
  'event.list',
  { thread_id: string; before_event_id?: string | null; limit?: number }
>

// --- Settings C2S ---

export type C2S_SettingsSubscribe = Frame<
  'settings.subscribe',
  {
    worker_id: string
    audience?: 'creator' | 'user'
    agent_owner_user_id?: string | null
  }
>

export type C2S_SettingsUnsubscribe = Frame<'settings.unsubscribe', { worker_id: string }>

export type C2S_SettingsPatch = Frame<'settings.patch', { field_id: string; value: unknown }>

// --- Feedback C2S ---

export type C2S_Feedback = Frame<
  'feedback',
  {
    target_type: string
    target_id: string
    feedback: 'like' | 'dislike'
    reason?: string
    classification?: string
  }
>

// --- Analytics C2S ---

export type C2S_AnalyticsSubscribe = Frame<'analytics.subscribe', { worker_id: string }>

export type C2S_AnalyticsUnsubscribe = Frame<'analytics.unsubscribe', { worker_id: string }>

export type ClientToServer =
  | C2S_Connect
  | C2S_ThreadList
  | C2S_ThreadSubscribe
  | C2S_ThreadUnsubscribe
  | C2S_ThreadDelete
  | C2S_EventCreate
  | C2S_EventList
  | C2S_SettingsSubscribe
  | C2S_SettingsUnsubscribe
  | C2S_SettingsPatch
  | C2S_Feedback
  | C2S_AnalyticsSubscribe
  | C2S_AnalyticsUnsubscribe

// --- Server to Client (S2C) ---

export type S2C_Ack = Frame<
  'ack',
  { ack_id: string; ok: boolean; error?: { code: string; message: string } }
>

export type S2C_ThreadListResult = Frame<
  'thread.list.result',
  { threads: WireThread[]; cursor?: string | null; total_count: number }
>

export type S2C_ThreadSnapshot = Frame<
  'thread.snapshot',
  { thread: WireThread; events: WireThreadEvent[]; runs?: WireRun[] }
>

export type S2C_EventAppend = Frame<
  'event.append',
  { thread_id: string; events: WireThreadEvent[] }
>

export type S2C_EventListResult = Frame<
  'event.list.result',
  {
    thread_id: string
    events: WireThreadEvent[]
    cursor: string | null
    has_more: boolean
  }
>

export type S2C_ThreadUpsert = Frame<'thread.upsert', { thread: WireThread }>

export type S2C_ThreadDeleted = Frame<'thread.deleted', { thread_id: string }>

export type S2C_RunUpsert = Frame<'run.upsert', { run: WireRun }>

// --- Settings S2C ---

export type S2C_SettingsSnapshot = Frame<
  'settings.snapshot',
  { worker_id: string; fields: WireSettingsItem[]; updated_at: string }
>

export type S2C_SettingsPatch = Frame<
  'settings.patch',
  { worker_id: string; field_id: string; value: unknown; updated_at: string }
>

// --- Feedback S2C ---

export type S2C_FeedbackAck = Frame<
  'feedback.ack',
  {
    target_type: string
    target_id: string
    feedback: string
    ok: boolean
  }
>

// --- Analytics S2C ---

export type S2C_AnalyticsEvent = Frame<'analytics.event', WireAnalyticsEvent>

export type ServerToClient =
  | S2C_Ack
  | S2C_ThreadListResult
  | S2C_ThreadSnapshot
  | S2C_EventAppend
  | S2C_EventListResult
  | S2C_ThreadUpsert
  | S2C_ThreadDeleted
  | S2C_RunUpsert
  | S2C_SettingsSnapshot
  | S2C_SettingsPatch
  | S2C_FeedbackAck
  | S2C_AnalyticsEvent
