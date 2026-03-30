# agents-server-client — Client SDK Design

**Status**: Approved
**Date**: 2026-02-13

## Overview

React SDK for connecting to agents-server backends. Provides a `<AgentProvider>` and hooks for real-time threads, messaging, and runs over WebSocket.

The SDK is the frontend sibling of `agents-server` (the Python backend SDK). Together they form the complete stack: backend handlers produce events, this SDK consumes them.

## Decisions

| Decision | Choice |
|----------|--------|
| Scope | Core + messaging (threads, events, runs). Settings/analytics/feedback in Phase 2. |
| API style | `<AgentProvider>` + hooks |
| Internal state | Zustand (hidden from consumers) |
| Package | Single: `agents-server-client` |
| Hook granularity | Auto-subscribe with selectors |
| Optimistic updates | Built-in |

## Consumer API

The entire public surface is a provider and 4 hooks.

### AgentProvider

```tsx
import { AgentProvider } from "agents-server-client"

<AgentProvider
  url="wss://api.example.com/ws"
  agentId="agent-1"
  metadata={{
    organizationId: "org-1",
    workspaceId: "ws-1",
    user: { id: "user-1", name: "Alice", email: "alice@co.com", role: "member" },
  }}
  onError={(error) => console.error(error)}   // optional
>
  <App />
</AgentProvider>
```

Props:

```ts
interface AgentProviderProps {
  url: string
  agentId: string
  metadata?: {
    organizationId?: string
    workspaceId?: string
    user?: {
      id: string
      name?: string
      email?: string
      role?: string
    }
    authToken?: string
  }
  onError?: (error: { code: string; message: string; frameType: string }) => void
  children: ReactNode
}
```

`url` and `agentId` are the only required props. `metadata` carries organizational context and user identity — optional because it's not intrinsically related to the thread/event/run dynamics.

### useConnection

Read connection status, trigger manual reconnect.

```ts
const { status, error, reconnectFailed, reconnect } = useConnection()
// status: "idle" | "connecting" | "connected" | "disconnected" | "error"
```

### useThreads

Read thread list, delete threads.

```ts
const { threads, isLoading, deleteThread } = useThreads()
```

### useThread

Subscribe to a thread. Auto-subscribes on mount, unsubscribes on unmount. Supports selectors for render optimization.

```ts
// Full state
const { events, runs, thread, isLoading } = useThread(threadId)

// Selector — only re-renders when events change
const events = useThread(threadId, { select: s => s.events })

// Derived — only re-renders when value changes
const isRunning = useThread(threadId, {
  select: s => s.runs.some(r => r.status === "running"),
})
```

### useMessage

Send messages with built-in optimistic updates.

```ts
const { send, isWaiting } = useMessage()

send({ text: "Hello!", threadId })
send({ text: "New conversation" })          // no threadId → creates new thread
send({ content: [{ type: "text", text: "..." }], threadId })  // explicit content parts
```

### Full Example

```tsx
import {
  AgentProvider,
  useConnection,
  useThreads,
  useThread,
  useMessage,
} from "agents-server-client"

function App() {
  return (
    <AgentProvider
      url="wss://api.example.com/ws"
      agentId="agent-1"
      metadata={{
        organizationId: "org-1",
        workspaceId: "ws-1",
        user: { id: "user-1", name: "Alice", email: "alice@co.com", role: "member" },
      }}
    >
      <ChatPage />
    </AgentProvider>
  )
}

function StatusBar() {
  const { status, error, reconnect } = useConnection()
  if (status === "error") return <button onClick={reconnect}>Retry</button>
  return <span>{status}</span>
}

function ThreadList() {
  const { threads, deleteThread } = useThreads()
  return threads.map(t => <li key={t.id}>{t.title}</li>)
}

function ChatView({ threadId }: { threadId: string }) {
  const { events, runs, isLoading } = useThread(threadId)
  const isRunning = runs.some(r => r.status === "running")
  return <MessageList events={events} isRunning={isRunning} />
}

function ChatInput({ threadId }: { threadId?: string }) {
  const { send, isWaiting } = useMessage()
  return (
    <form onSubmit={e => {
      e.preventDefault()
      send({ text: "Hello!", threadId })
    }}>
      <input disabled={isWaiting} />
    </form>
  )
}
```

## Architecture

Three layers, each with a single responsibility:

```
┌─────────────────────────────────────────────┐
│  Hooks Layer (public API)                   │
│  useConnection, useThreads, useThread,      │
│  useMessage                                 │
│  ─ thin selectors over the store ─          │
├─────────────────────────────────────────────┤
│  Store Layer (Zustand)                      │
│  connection status, threads map,            │
│  events map, runs map, optimistic queue     │
│  ─ pure state + reducers, no side effects ─ │
├─────────────────────────────────────────────┤
│  Client Layer (vanilla JS)                  │
│  WebSocket lifecycle, frame serialization,  │
│  reconnection, routing S2C → store actions  │
│  ─ no React, no Zustand dependency ─        │
└─────────────────────────────────────────────┘
```

**Client layer** (`AgentClient`) — a plain class, no React:
- Opens/closes WebSocket, sends C2S frames, parses S2C frames
- Exponential backoff reconnection (5 attempts: 1s, 2s, 4s, 8s, 16s)
- Accepts a callbacks object — the store wires itself as the listener
- Testable in isolation (Node, Vitest, no jsdom needed)

**Store layer** (`createAgentStore`) — a Zustand store factory:
- Created per `<AgentProvider>` mount, not a global singleton
- Receives S2C frame data via callbacks, updates state immutably
- Normalized shape: threads and events keyed by ID, not arrays
- Optimistic events tracked separately, merged in selectors

**Hooks layer** — thin wrappers:
- Each hook calls `useStore(selector)` with fine-grained selectors
- `useThread(id)` triggers a subscribe side-effect via `useEffect`, reads from the store
- Zustand's selector equality prevents unnecessary re-renders

### Provider Wiring

```tsx
function AgentProvider({ url, agentId, metadata, onError, children }: AgentProviderProps) {
  const store = useRef<AgentStore>()
  const client = useRef<AgentClient>()

  if (!store.current) {
    store.current = createAgentStore()
    client.current = new AgentClient(store.current.getState().actions)
  }

  useEffect(() => {
    client.current.connect(url, agentId, metadata)
    return () => client.current.disconnect()
  }, [url, agentId, metadata])

  return (
    <AgentContext.Provider value={{ store: store.current, client: client.current }}>
      {children}
    </AgentContext.Provider>
  )
}
```

Key decisions:
- **Store per provider, not global** — multiple `<AgentProvider>` on the same page work independently
- **Client is vanilla JS** — separating WebSocket from React means it's testable and potentially reusable outside React later
- **Normalized state** — `Record<string, Thread>`, `Record<string, ThreadEvent[]>` — O(1) lookups

## Store Shape

```ts
interface AgentState {
  // Connection
  connection: {
    status: "idle" | "connecting" | "connected" | "disconnected" | "error"
    error: string | null
    reconnectAttempts: number
    reconnectFailed: boolean
  }

  // Threads (keyed by thread ID)
  threads: Record<string, Thread>
  threadOrder: string[]                // sorted by last_event_at desc

  // Events (keyed by thread ID → array)
  events: Record<string, ThreadEvent[]>
  optimistic: Record<string, ThreadEvent[]>  // pending confirmation

  // Runs (keyed by thread ID → array)
  runs: Record<string, Run[]>

  // Subscriptions (which threads are actively subscribed)
  subscriptions: Set<string>

  // Per-thread loading state
  loadingThreads: Set<string>
}
```

### Why Normalized (Not Flat Arrays)

The current `dooers-app-web` keeps a single `events: ThreadEvent[]` and swaps it when switching threads. That works for one-thread-at-a-time UI, but the SDK shouldn't force that pattern. A consumer might render two threads side by side, or prefetch events for a list preview.

With `events: Record<string, ThreadEvent[]>`:
- Subscribing to thread A doesn't wipe thread B's data
- `useThread("a")` and `useThread("b")` work simultaneously
- The store is the cache — no data loss on navigation

### Optimistic Merge

Optimistic events live in a separate map. Hooks merge them at read time:

```ts
// Inside useThread selector
const allEvents = [
  ...state.optimistic[threadId] ?? [],
  ...state.events[threadId] ?? [],
]
```

When the server confirms (`event.append` with real event):
1. Append real event to `events[threadId]`
2. Remove matching optimistic entry from `optimistic[threadId]`
3. Match by `client_event_id` — a UUID the SDK generates per send

### Store Actions

```ts
interface AgentActions {
  // Connection
  setConnectionStatus(status, error?)
  resetReconnect()

  // S2C handlers
  onThreadList(threads: Thread[])
  onThreadUpsert(thread: Thread)
  onThreadDeleted(threadId: string)
  onThreadSnapshot(thread: Thread, events: ThreadEvent[], runs: Run[])
  onEventAppend(threadId: string, events: ThreadEvent[])
  onRunUpsert(run: Run)

  // User actions
  addOptimistic(threadId: string, event: ThreadEvent, clientEventId: string)
  removeOptimistic(threadId: string, clientEventId: string)

  // Subscription tracking
  addSubscription(threadId: string)
  removeSubscription(threadId: string)
}
```

Actions are pure state transitions — no async, no WebSocket calls.

## Hook Implementations

### useConnection

```ts
function useConnection() {
  const { store, client } = useAgentContext()

  const status = useStore(store, s => s.connection.status)
  const error = useStore(store, s => s.connection.error)
  const reconnectFailed = useStore(store, s => s.connection.reconnectFailed)

  const reconnect = useCallback(() => client.retry(), [client])

  return { status, error, reconnectFailed, reconnect }
}
```

### useThreads

```ts
function useThreads() {
  const { store, client } = useAgentContext()

  const threads = useStore(store, s =>
    s.threadOrder.map(id => s.threads[id]).filter(Boolean)
  )
  const isLoading = useStore(store, s => s.connection.status !== "connected")

  const deleteThread = useCallback(
    (threadId: string) => client.deleteThread(threadId),
    [client],
  )

  return { threads, isLoading, deleteThread }
}
```

### useThread

```ts
function useThread<T = ThreadState>(
  threadId: string | null,
  options?: { select?: (state: ThreadState) => T },
) {
  const { store, client } = useAgentContext()

  // Auto-subscribe/unsubscribe
  useEffect(() => {
    if (!threadId) return
    client.subscribe(threadId)
    return () => client.unsubscribe(threadId)
  }, [threadId, client])

  const select = options?.select ?? (s => s as T)

  return useStore(store, s => {
    if (!threadId) return select(EMPTY_THREAD_STATE)

    const optimistic = s.optimistic[threadId] ?? []
    const confirmed = s.events[threadId] ?? []

    return select({
      events: [...optimistic, ...confirmed],
      runs: s.runs[threadId] ?? [],
      thread: s.threads[threadId] ?? null,
      isLoading: s.loadingThreads.has(threadId),
    })
  })
}
```

### useMessage

```ts
function useMessage() {
  const { store, client } = useAgentContext()

  const isWaiting = useStore(store, s => {
    for (const threadId of s.subscriptions) {
      const runs = s.runs[threadId] ?? []
      if (runs.some(r => r.status === "running")) return true
    }
    return false
  })

  const send = useCallback(
    (params: { text: string; threadId?: string; content?: ContentPart[] }) => {
      client.sendMessage(params)
    },
    [client],
  )

  return { send, isWaiting }
}
```

`client.sendMessage()` internally:
1. Generates a `clientEventId` (UUID)
2. Builds optimistic `ThreadEvent` and calls `store.addOptimistic()`
3. Sends `event.create` C2S frame with `client_event_id`
4. When `event.append` arrives, `removeOptimistic()` + `onEventAppend()`

## AgentClient

Vanilla JS class (~200-250 lines). No React, no Zustand import. Communicates via a callbacks interface that maps 1:1 to store actions.

### Callback Interface

```ts
interface AgentClientCallbacks {
  setConnectionStatus: AgentActions["setConnectionStatus"]
  resetReconnect: AgentActions["resetReconnect"]
  onThreadList: AgentActions["onThreadList"]
  onThreadUpsert: AgentActions["onThreadUpsert"]
  onThreadDeleted: AgentActions["onThreadDeleted"]
  onThreadSnapshot: AgentActions["onThreadSnapshot"]
  onEventAppend: AgentActions["onEventAppend"]
  onRunUpsert: AgentActions["onRunUpsert"]
  addOptimistic: AgentActions["addOptimistic"]
  removeOptimistic: AgentActions["removeOptimistic"]
  addSubscription: AgentActions["addSubscription"]
  removeSubscription: AgentActions["removeSubscription"]
}
```

### Frame Routing

```ts
private route(frame: ServerToClient) {
  switch (frame.type) {
    case "ack":
      if (frame.payload.ack_id === this.connectFrameId) {
        if (frame.payload.ok) {
          this.callbacks.setConnectionStatus("connected")
          this.callbacks.resetReconnect()
          this.requestThreadList()
        } else {
          this.callbacks.setConnectionStatus("error", frame.payload.error?.message)
        }
      }
      break

    case "thread.list.result":
      this.callbacks.onThreadList(frame.payload.threads)
      break

    case "thread.snapshot":
      this.callbacks.onThreadSnapshot(
        frame.payload.thread,
        frame.payload.events,
        frame.payload.runs ?? [],
      )
      break

    case "event.append":
      for (const event of frame.payload.events) {
        const pending = this.findOptimistic(event)
        if (pending) {
          this.callbacks.removeOptimistic(pending.threadId, pending.clientEventId)
          this.pendingOptimistic.delete(pending.clientEventId)
        }
      }
      this.callbacks.onEventAppend(frame.payload.thread_id, frame.payload.events)
      break

    case "thread.upsert":
      this.callbacks.onThreadUpsert(frame.payload.thread)
      break

    case "thread.deleted":
      this.callbacks.onThreadDeleted(frame.payload.thread_id)
      break

    case "run.upsert":
      this.callbacks.onRunUpsert(frame.payload.run)
      break
  }
}
```

### Public Methods

```ts
// Connection
connect(url, agentId, metadata?)
disconnect()
retry()

// Threads
requestThreadList(cursor?, limit?)
subscribe(threadId)
unsubscribe(threadId)
deleteThread(threadId)

// Messaging
sendMessage({ text, threadId?, content? })
```

### Reconnection

5 attempts with exponential backoff: 1s, 2s, 4s, 8s, 16s.

On successful reconnect:
1. Re-sends `connect` frame
2. Re-requests thread list
3. Re-subscribes to all threads in `subscriptions` set
4. Uses `after_event_id` (last known event per thread) for gap recovery

### Refcounted Subscriptions

Multiple `useThread` hooks for the same thread share a single WebSocket subscription:

```ts
private subscriptionRefs: Map<string, number> = new Map()

subscribe(threadId: string) {
  const refs = this.subscriptionRefs.get(threadId) ?? 0
  this.subscriptionRefs.set(threadId, refs + 1)
  if (refs === 0) {
    this.send("thread.subscribe", { thread_id: threadId })
    this.callbacks.addSubscription(threadId)
  }
}

unsubscribe(threadId: string) {
  const refs = this.subscriptionRefs.get(threadId) ?? 0
  if (refs <= 1) {
    this.subscriptionRefs.delete(threadId)
    this.send("thread.unsubscribe", { thread_id: threadId })
    this.callbacks.removeSubscription(threadId)
  } else {
    this.subscriptionRefs.set(threadId, refs - 1)
  }
}
```

### Frame Serialization

```ts
private send(type: string, payload: unknown) {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
  this.ws.send(JSON.stringify({ id: crypto.randomUUID(), type, payload }))
}
```

Incoming frames are JSON-parsed and snake_case keys are normalized to camelCase at the boundary.

## Error Handling

### Connection Errors

Surfaced via `useConnection()`. The client never throws — failures flow as state:

```
"connecting" → "disconnected" (reconnecting) → "error" (gave up)
```

### Protocol Errors

Server ack with `ok: false`. Surfaced via optional `onError` on the provider. Without `onError`, silently ignored.

### Handler Errors

Arrive as `run.upsert` with `status: "failed"`. Read from `useThread()`:

```tsx
const { runs } = useThread(threadId)
const failedRun = runs.find(r => r.status === "failed")
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Send while disconnected | Queued, sent on reconnect. Optimistic event shown immediately. |
| Subscribe before connected | Deferred until `ack` received. |
| Reconnect with stale data | Re-subscribes with `afterEventId`. Server sends only missing events. |
| Duplicate `event.append` | Deduplicated by event ID before appending. |
| `useThread` unmounts during load | Unsubscribe sent. Snapshot response ignored. |
| Multiple `useThread` same thread | Refcounted. Unsubscribe when last hook unmounts. |

## Package Structure

```
src/
├── main.ts                   # Public exports
├── types.ts                  # All exported types
├── client.ts                 # AgentClient class
├── store.ts                  # createAgentStore + actions
├── provider.tsx              # AgentProvider + AgentContext
├── hooks/
│   ├── use-connection.ts
│   ├── use-threads.ts
│   ├── use-thread.ts
│   └── use-message.ts
└── protocol/
    ├── frames.ts             # C2S/S2C frame types + builders
    └── models.ts             # Thread, ThreadEvent, Run, ContentPart
```

### Public Exports

```ts
// Components
export { AgentProvider } from "./provider"
export type { AgentProviderProps, AgentMetadata } from "./provider"

// Hooks
export { useConnection } from "./hooks/use-connection"
export { useThreads } from "./hooks/use-threads"
export { useThread } from "./hooks/use-thread"
export { useMessage } from "./hooks/use-message"

// Types
export type {
  Thread,
  ThreadEvent,
  Run,
  RunStatus,
  ContentPart,
  TextPart,
  ImagePart,
  DocumentPart,
  ThreadState,
  ConnectionStatus,
} from "./types"
```

### Exported Types

```ts
type ContentPart = TextPart | ImagePart | DocumentPart

interface TextPart {
  type: "text"
  text: string
}

interface ImagePart {
  type: "image"
  url: string
  mimeType?: string
  alt?: string
}

interface DocumentPart {
  type: "document"
  url: string
  filename: string
  mimeType: string
}

interface Thread {
  id: string
  agentId: string
  title: string | null
  createdAt: string
  updatedAt: string
  lastEventAt: string
}

interface ThreadEvent {
  id: string
  threadId: string
  runId: string | null
  type: "message" | "run.started" | "run.finished" | "tool.call" | "tool.result" | "tool.transaction"
  actor: "user" | "assistant" | "system" | "tool"
  author: string | null
  content?: ContentPart[]
  data?: Record<string, unknown>
  createdAt: string
}

interface Run {
  id: string
  threadId: string
  agentId: string | null
  status: "running" | "succeeded" | "failed" | "canceled"
  startedAt: string
  endedAt: string | null
  error: string | null
}

interface ThreadState {
  thread: Thread | null
  events: ThreadEvent[]
  runs: Run[]
  isLoading: boolean
}

type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error"
```

snake_case from the protocol is normalized to camelCase at the client boundary. Consumers never see snake_case.

### Dependencies

```json
{
  "dependencies": {
    "zustand": "^5.0.0"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0"
  }
}
```

Single runtime dependency. Build with tsup, dual ESM/CJS output, TypeScript declarations.

## Phase 2: Extension Path

Settings, analytics, and feedback plug in without changing existing hooks or breaking consumers.

### New Hooks

```ts
// Settings — auto-subscribes on mount
function useSettings() {
  const { fields, isLoading } = useStore(store, s => s.settings)
  const patch = useCallback(
    (fieldId: string, value: unknown) => client.patchSetting(fieldId, value),
    [client],
  )
  return { fields, isLoading, patch }
}

// Analytics — auto-subscribes on mount
function useAnalytics() {
  const events = useStore(store, s => s.analytics.events)
  const counters = useStore(store, s => s.analytics.counters)
  return { events, counters }
}

// Feedback — per event
function useFeedback(eventId: string) {
  const feedback = useStore(store, s => s.feedback[eventId] ?? null)
  const like = useCallback(
    (reason?: string) => client.sendFeedback("event", eventId, "like", reason),
    [client, eventId],
  )
  const dislike = useCallback(
    (reason?: string) => client.sendFeedback("event", eventId, "dislike", reason),
    [client, eventId],
  )
  return { feedback, like, dislike }
}
```

### What Changes

| Layer | Change |
|-------|--------|
| `store.ts` | Add `settings`, `analytics`, `feedback` slices + actions |
| `client.ts` | Add `route()` cases for `settings.*`, `analytics.*`, `feedback.ack` |
| `protocol/frames.ts` | Add 6 new C2S/S2C frame types |
| `hooks/` | 3 new files |
| `main.ts` | 3 new exports |

Nothing in `useConnection`, `useThreads`, `useThread`, or `useMessage` changes. No breaking release.

### Additional Store Slices

```ts
interface AgentStatePhase2 extends AgentState {
  settings: {
    fields: SettingsItem[]
    updatedAt: string | null
    isLoading: boolean
  }
  analytics: {
    events: AnalyticsEvent[]       // ring buffer, last 50
    counters: { requests: number; likes: number; dislikes: number }
  }
  feedback: Record<string, "like" | "dislike" | null>
}
```
