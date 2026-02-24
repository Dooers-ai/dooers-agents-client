# dooers-agents-client

React agents client SDK for agents server SDK.

## Install

```bash
npm install dooers-agents-client
```

Peer dependency: `react >= 18`

## Quick Start

Wrap your component tree in `WorkerProvider`, then use hooks anywhere inside.

```tsx
import { WorkerProvider, useConnection, useThreadDetails, useMessage } from "dooers-agents-client"

function App() {
  return (
    <WorkerProvider
      url="ws://localhost:8000/ws"
      workerId="worker-1"
      userId="user-1"
      userName="Alice"
    >
      <Chat threadId="thread-1" />
    </WorkerProvider>
  )
}

function Chat({ threadId }: { threadId: string }) {
  const { status } = useConnection()
  const { events, isWaiting } = useThreadDetails(threadId)
  const { send } = useMessage()

  return (
    <div>
      <p>{status}</p>

      {events.map((event) => (
        <div key={event.id}>
          <strong>{event.actor}</strong>
          {event.content?.map((part, i) =>
            part.type === "text" ? <p key={i}>{part.text}</p> : null
          )}
        </div>
      ))}

      {isWaiting && <p>Thinking...</p>}

      <button onClick={() => send({ text: "Hello!", threadId })}>
        Send
      </button>
    </div>
  )
}
```

## Provider

`WorkerProvider` manages the WebSocket lifecycle. On mount it connects, on unmount it disconnects. When any prop changes, the connection resets.

```tsx
<WorkerProvider
  url="ws://localhost:8000/ws"   // WebSocket endpoint
  workerId="worker-1"            // Worker to connect to
  organizationId="org-1"         // Context passed to handler
  workspaceId="ws-1"
  userId="user-1"
  userName="Alice"
  userEmail="alice@example.com"
  userRole="member"
  authToken="sk-..."             // Optional authentication
  onError={(err) => console.error(err.code, err.message)}
>
  {children}
</WorkerProvider>
```

All props except `children` and `onError` are primitive strings, so React can diff them cheaply.

## Hooks

All hooks must be called inside a `WorkerProvider`.

### useConnection

```tsx
const { status, error, reconnectFailed, reconnect } = useConnection()

// status: "idle" | "connecting" | "connected" | "disconnected" | "error"
```

Auto-reconnects up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s). When all attempts fail, `reconnectFailed` becomes `true` and you can offer a manual retry button calling `reconnect()`.

### useThreadDetails

```tsx
const { thread, events, runs, isLoading, isWaiting } = useThreadDetails(threadId)
```

Subscribes on mount, unsubscribes on unmount. Refcounted internally, so multiple components subscribing to the same thread share a single WebSocket subscription.

`events` includes optimistic messages that appear instantly when sending, then get replaced by the server-confirmed version. `isWaiting` is `true` while any run has status `"running"`.

### useThreadEvents

Load older messages beyond the initial snapshot.

```tsx
const { hasOlderEvents, loadOlderEvents } = useThreadEvents(threadId)

if (hasOlderEvents) {
  loadOlderEvents(50)  // load 50 more
}
```

### useThreadsList

Read-only thread list for the connected worker.

```tsx
const { threads, isLoading, hasMore, totalCount } = useThreadsList()
```

Threads load automatically on connect. `totalCount` reflects the server-reported total.

### useThreadsActions

Thread mutations (delete, load more).

```tsx
const { deleteThread, loadMore } = useThreadsActions()
```

`loadMore()` for cursor-based pagination. `deleteThread(id)` broadcasts deletion to all connected clients.

### useMessage

```tsx
const { send } = useMessage()

// Existing thread
send({ text: "Hello!", threadId: "t-1" })

// New thread (omit threadId — returns the created thread ID)
const { threadId } = await send({ text: "Start a conversation" })

// Rich content
send({
  threadId: "t-1",
  content: [
    { type: "text", text: "Check this out:" },
    { type: "image", url: "https://...", mimeType: "image/png" },
  ],
})
```

### useFeedback

```tsx
const { feedback, like, dislike } = useFeedback(eventId, "event")

// feedback: "like" | "dislike" | null
like()
dislike("The response was incorrect")
```

Second argument is the target type: `"event"`, `"run"`, or `"thread"`.

### useAnalytics

Live event stream. Subscribe and unsubscribe explicitly.

```tsx
const { events, counters, subscribe, unsubscribe } = useAnalytics()

useEffect(() => {
  subscribe()
  return () => unsubscribe()
}, [subscribe, unsubscribe])

// events: AnalyticsEvent[] — latest events
// counters: Record<string, number> — aggregated counters
```

### useSettings

Worker settings with real-time sync across clients.

```tsx
const { fields, updatedAt, isLoading, subscribe, unsubscribe, patchField } = useSettings()

// fields: (SettingsField | SettingsFieldGroup)[]
patchField("model", "gpt-4o")
```

Subscribe explicitly — designed so you only receive updates when the settings UI is visible:

```tsx
useEffect(() => {
  subscribe()
  return () => unsubscribe()
}, [subscribe, unsubscribe])
```

## Types

All public types are camelCase. The SDK transforms the wire format (snake_case) internally.

```typescript
import type {
  Thread,            // { id, workerId, title, createdAt, updatedAt, lastEventAt, metadata }
  ThreadEvent,       // { id, threadId, type, actor, author, content, data, createdAt, ... }
  Run,               // { id, threadId, agentId, status, startedAt, endedAt, error }
  ContentPart,       // TextPart | ImagePart | DocumentPart
  Metadata,          // { userId, userName, userEmail, userRole, organizationId, workspaceId }
  ConnectionStatus,  // "idle" | "connecting" | "connected" | "disconnected" | "error"
  Actor,             // "user" | "assistant" | "system" | "tool"
  EventType,         // "message" | "tool.call" | "tool.result" | "tool.transaction" | ...
  RunStatus,         // "running" | "succeeded" | "failed" | "canceled"
  ThreadState,       // { thread, events, runs, isLoading, isWaiting }
  SettingsField,
  SettingsFieldGroup,
  SettingsItem,      // SettingsField | SettingsFieldGroup
  AnalyticsEvent,
  FeedbackType,      // "like" | "dislike"
  FeedbackTarget,    // "event" | "run" | "thread"
} from "dooers-agents-client"

import { isSettingsFieldGroup } from "dooers-agents-client"  // type guard
```

## Architecture

```
WorkerProvider
  ├── WorkerClient       WebSocket lifecycle, reconnection, optimistic events
  └── WorkerStore        Zustand vanilla store
        ├── connection   { status, error, reconnectFailed }
        ├── threads      Record<id, Thread>
        ├── events       Record<threadId, ThreadEvent[]>
        ├── optimistic   Record<threadId, ThreadEvent[]>  (merged into events by useThreadDetails)
        ├── runs         Record<threadId, Run[]>
        ├── settings     { fields, updatedAt, isLoading }
        ├── analytics    { events, counters }
        └── feedback     Record<targetId, FeedbackType>
```

The client handles:

- **Optimistic messages** — shown immediately on send, reconciled when the server confirms via `clientEventId`
- **Refcounted subscriptions** — multiple `useThreadDetails(id)` calls share one WebSocket subscription
- **Gap recovery** — on reconnect, sends `afterEventId` to resume from where the client left off
- **Exponential backoff** — reconnects at 1s, 2s, 4s, 8s, 16s intervals before giving up

## See Also

- [dooers-agents-server](https://github.com/Dooers-ai/dooers-agents-server) — Python SDK for building the agents this client connects to
