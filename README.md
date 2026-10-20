# dooers-agents-client

React agents client SDK for agents server SDK.

## Install

```bash
npm install dooers-agents
```

Peer dependency: `react >= 18`

## Quick Start

Wrap your component tree in `AgentProvider`, then use hooks anywhere inside.

```tsx
import { AgentProvider, useConnection, useThreadDetails, useMessage } from "dooers-agents"

function App() {
  return (
    <AgentProvider
      url="ws://localhost:8000/ws"
      agentId="agent-1"
      userId="user-1"
      userName="Alice"
    >
      <Chat threadId="thread-1" />
    </AgentProvider>
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

`AgentProvider` manages the WebSocket lifecycle. On mount it connects, on unmount it disconnects. When any prop changes, the connection resets.

```tsx
<AgentProvider
  url="ws://localhost:8000/ws"   // WebSocket endpoint
  agentId="agent-1"            // Agent to connect to
  organizationId="org-1"         // Context passed to handler
  workspaceId="ws-1"
  userId="user-1"
  userName="Alice"
  userEmail="alice@example.com"
  systemRole="user"              // "admin" | "user" (default: "user")
  organizationRole="member"      // "owner" | "manager" | "member" (default: "member")
  workspaceRole="member"         // "manager" | "member" (default: "member")
  authToken="sk-..."             // Optional authentication
  getAuthToken={fetchToken}      // Optional: called before every socket and upload (wins over authToken)
  onError={(err) => console.error(err.code, err.message)}
>
  {children}
</AgentProvider>
```

All props except `children`, `onError` and `getAuthToken` are primitive strings, so React can diff them cheaply. `getAuthToken` may return a cached token, but not one about to expire: reconnects and the planned renewal send whatever it returns. A call that has not settled within 15s counts as a failed attempt.

## Hooks

All hooks must be called inside a `AgentProvider`.

### useConnection

```tsx
const { status, error, reconnectFailed, reconnect } = useConnection()

// status: "idle" | "connecting" | "connected" | "disconnected" | "error"
```

Auto-reconnects up to 5 times in a row with exponential backoff (1s, 2s, 4s, 8s, 16s, each ±20%). A connection that stays up for 30s resets the count; one dropped sooner counts as a failed attempt. When all attempts fail, `reconnectFailed` becomes `true` and you can offer a manual retry button calling `reconnect()`. A tab becoming visible again or the browser coming back `online` makes one immediate attempt: while waiting it keeps the failure count, and after giving up a single failed try gives up again. `reconnect()` is what grants a fresh set of attempts.

The client pings every 30s and treats a socket silent for 90s as dropped (5 minutes while a run is in progress or a request is pending, since the agent server does not answer pings while it runs a turn). Pings and this check apply only to servers that announce their version on connect (agents-server 0.17.1+); older servers get neither, because before 0.10.3 they close the socket on a `ping`. It also renews the connection before the hosting cuts it: after 30 minutes with nothing pending and no run in progress (55 minutes at the latest), it opens a second socket and switches over once that one is accepted. When the renewal succeeds, `status` stays `connected` and pending requests are not aborted; a reply still in transit on the old socket at the swap can time out. A renewal that keeps failing falls back to a normal reconnect when the hosting cuts the socket.

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

Read-only thread list for the connected agent.

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

Agent settings with real-time sync across clients.

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
  User,              // { userId, userName, userEmail, systemRole, organizationRole, workspaceRole }
  Thread,            // { id, agentId, organizationId, workspaceId, owner, users, title, ... }
  ThreadEvent,       // { id, threadId, type, actor, author, user, content, data, createdAt, ... }
  Run,               // { id, threadId, agentId, status, startedAt, endedAt, error }
  ContentPart,       // TextPart | ImagePart | DocumentPart
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
} from "dooers-agents"

import { isSettingsFieldGroup } from "dooers-agents"  // type guard
```

## Architecture

```
AgentProvider
  ├── AgentClient       WebSocket lifecycle, reconnection, optimistic events
  └── AgentStore        Zustand vanilla store
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
- **Exponential backoff** — reconnects at 1s, 2s, 4s, 8s, 16s intervals (±20%) before giving up
- **Planned renewal** — swaps to a fresh socket every 30–55 minutes, make-before-break, without a status change when it succeeds

## See Also

- [dooers-agents-server](https://github.com/Dooers-ai/dooers-agents-server) — Python SDK for building the agents this client connects to
