import type {
  WireAnalyticsEvent,
  WireC2S_ContentPart,
  WireMemoryPreferences,
  WireMemoryRecord,
  WireRun,
  WireScheduleRecord,
  WireSettingsItem,
  WireThread,
  WireThreadArtifact,
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
    agent_id: string
    organization_id: string
    workspace_id: string
    user: WireUser
    auth_token?: string
    client?: { name: string; version: string }
  }
>

export type C2S_ThreadList = Frame<
  'thread.list',
  { cursor?: string | null; limit?: number; queue?: string | null }
>

/** Title search over every thread the connection may see (agents-server ≥ 0.25.0). */
export type C2S_ThreadSearch = Frame<
  'thread.search',
  { query: string; cursor?: string | null; limit?: number; queue?: string | null }
>

export type C2S_ThreadUpdate = Frame<'thread.update', { thread_id: string; queue?: string | null }>

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
      type: 'message' | 'form.response'
      actor: 'user'
      content: WireC2S_ContentPart[]
      data?: Record<string, unknown>
    }
    metadata?: Record<string, unknown>
    chat_context?: {
      llm_model?: string | null
      reasoning_effort?: string | null
      timezone?: string | null
      locale?: string | null
    }
    queue?: string | null
  }
>

// --- Run control / long-term memory / schedules (agents-server ≥ 0.26.0) ---

export type C2S_RunCancel = Frame<'run.cancel', { thread_id: string; run_id?: string | null }>

export type C2S_MemoryList = Frame<
  'memory.list',
  {
    scope?: 'user' | 'workspace' | null
    query?: string | null
    cursor?: string | null
    limit?: number
  }
>

export type C2S_MemoryCreate = Frame<
  'memory.create',
  {
    content: string
    scope?: 'user' | 'workspace'
    kind?: string
    tags?: string[]
    pinned?: boolean
  }
>

export type C2S_MemoryUpdate = Frame<
  'memory.update',
  { memory_id: string; content?: string; tags?: string[]; pinned?: boolean; kind?: string }
>

export type C2S_MemoryDelete = Frame<'memory.delete', { memory_id: string }>

export type C2S_MemoryPrefsGet = Frame<'memory.prefs.get', Record<string, never>>

export type C2S_MemoryPrefsUpdate = Frame<
  'memory.prefs.update',
  { enabled?: boolean; custom_instructions?: string; about_me?: string }
>

export type C2S_ScheduleList = Frame<
  'schedule.list',
  { thread_id?: string | null; include_closed?: boolean }
>

export type C2S_ScheduleUpdate = Frame<
  'schedule.update',
  { schedule_id: string; status: 'active' | 'paused' }
>

export type C2S_ScheduleDelete = Frame<'schedule.delete', { schedule_id: string }>

// --- Event pagination C2S ---

export type C2S_EventList = Frame<
  'event.list',
  { thread_id: string; before_event_id?: string | null; limit?: number }
>

export type C2S_ThreadArtifactsList = Frame<
  'thread.artifacts.list',
  {
    thread_id: string
    cursor?: string | null
    limit?: number
    direction?: 'in' | 'out' | 'all'
  }
>

// --- Settings C2S ---

export type C2S_SettingsSubscribe = Frame<
  'settings.subscribe',
  {
    agent_id: string
    audience?: 'creator' | 'user'
    agent_owner_user_id?: string | null
  }
>

export type C2S_SettingsUnsubscribe = Frame<'settings.unsubscribe', { agent_id: string }>

export type C2S_SettingsPatch = Frame<'settings.patch', { field_id: string; value: unknown }>

export type C2S_SettingsPublicSchema = Frame<'settings.public_schema', Record<string, never>>

export type C2S_SettingsSeed = Frame<
  'settings.seed',
  {
    worker_id: string
    values: Record<string, unknown>
    seed_secret: string
    next_seed_secret?: string | null
    /** When true, server shallow-merges values onto existing worker settings. */
    merge?: boolean
  }
>

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

export type C2S_AnalyticsSubscribe = Frame<'analytics.subscribe', { agent_id: string }>

export type C2S_AnalyticsUnsubscribe = Frame<'analytics.unsubscribe', { agent_id: string }>

export type C2S_Ping = Frame<'ping', Record<string, never>>

export type ClientToServer =
  | C2S_Connect
  | C2S_ThreadList
  | C2S_ThreadSearch
  | C2S_ThreadSubscribe
  | C2S_ThreadUnsubscribe
  | C2S_ThreadDelete
  | C2S_ThreadUpdate
  | C2S_EventCreate
  | C2S_EventList
  | C2S_ThreadArtifactsList
  | C2S_SettingsSubscribe
  | C2S_SettingsUnsubscribe
  | C2S_SettingsPatch
  | C2S_SettingsPublicSchema
  | C2S_SettingsSeed
  | C2S_Feedback
  | C2S_AnalyticsSubscribe
  | C2S_AnalyticsUnsubscribe
  | C2S_RunCancel
  | C2S_MemoryList
  | C2S_MemoryCreate
  | C2S_MemoryUpdate
  | C2S_MemoryDelete
  | C2S_MemoryPrefsGet
  | C2S_MemoryPrefsUpdate
  | C2S_ScheduleList
  | C2S_ScheduleUpdate
  | C2S_ScheduleDelete
  | C2S_Ping

// --- Server to Client (S2C) ---

export type S2C_Ack = Frame<
  'ack',
  {
    ack_id: string
    ok: boolean
    error?: { code: string; message: string }
    server?: { name: string; version: string }
  }
>

export type S2C_ThreadListResult = Frame<
  'thread.list.result',
  { threads: WireThread[]; cursor?: string | null; total_count: number }
>

export type S2C_ThreadSearchResult = Frame<
  'thread.search.result',
  { query: string; threads: WireThread[]; cursor?: string | null; total_count: number }
>

export type S2C_ThreadSnapshot = Frame<
  'thread.snapshot',
  { thread: WireThread; events: WireThreadEvent[]; runs?: WireRun[]; has_more?: boolean }
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

export type S2C_ThreadArtifactsListResult = Frame<
  'thread.artifacts.list.result',
  {
    thread_id: string
    artifacts: WireThreadArtifact[]
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
  { agent_id: string; fields: WireSettingsItem[]; updated_at: string }
>

export type S2C_SettingsPatch = Frame<
  'settings.patch',
  { agent_id: string; field_id: string; value: unknown; updated_at: string }
>

export type S2C_SettingsPublicSchemaResult = Frame<
  'settings.public_schema.result',
  { schema?: Record<string, unknown>; schema_?: Record<string, unknown> }
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

/** Incremental text for an event announced with ``streaming: true`` (agents-server ≥ 0.26.0). */
export type S2C_EventDelta = Frame<
  'event.delta',
  {
    thread_id: string
    event_id: string
    run_id?: string | null
    kind: 'text' | 'reasoning'
    delta: string
    seq: number
  }
>

export type S2C_MemoryListResult = Frame<
  'memory.list.result',
  {
    memories: WireMemoryRecord[]
    cursor?: string | null
    has_more: boolean
    available: boolean
    can_manage_workspace: boolean
  }
>

export type S2C_MemoryUpsert = Frame<'memory.upsert', { memory: WireMemoryRecord }>

export type S2C_MemoryDeleted = Frame<'memory.deleted', { memory_id: string }>

export type S2C_MemoryPrefs = Frame<
  'memory.prefs',
  { prefs: WireMemoryPreferences; available: boolean }
>

export type S2C_ScheduleListResult = Frame<
  'schedule.list.result',
  { schedules: WireScheduleRecord[]; available: boolean }
>

export type S2C_ScheduleUpsert = Frame<'schedule.upsert', { schedule: WireScheduleRecord }>

export type S2C_ScheduleDeleted = Frame<'schedule.deleted', { schedule_id: string }>

export type S2C_Pong = Frame<'pong', Record<string, never>>

export type ServerToClient =
  | S2C_Ack
  | S2C_ThreadListResult
  | S2C_ThreadSearchResult
  | S2C_ThreadSnapshot
  | S2C_EventAppend
  | S2C_EventListResult
  | S2C_ThreadArtifactsListResult
  | S2C_ThreadUpsert
  | S2C_ThreadDeleted
  | S2C_RunUpsert
  | S2C_SettingsSnapshot
  | S2C_SettingsPatch
  | S2C_SettingsPublicSchemaResult
  | S2C_FeedbackAck
  | S2C_AnalyticsEvent
  | S2C_EventDelta
  | S2C_MemoryListResult
  | S2C_MemoryUpsert
  | S2C_MemoryDeleted
  | S2C_MemoryPrefs
  | S2C_ScheduleListResult
  | S2C_ScheduleUpsert
  | S2C_ScheduleDeleted
  | S2C_Pong
