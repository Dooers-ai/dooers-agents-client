# workers-server-client v2.0.0 — Architecture Improvement Proposal

**Status**: Proposal
**Date**: 2026-02-15
**Scope**: Both `workers-server-client` (client SDK) and `workers-server` (server SDK)

## Summary

The v1.x SDK achieves full protocol coverage, normalized state, cursor pagination, optimistic reconciliation, and ref-counted subscriptions. However, several architectural patterns limit maintainability, extensibility, and production reliability at scale.

This document catalogs every improvement identified during the v1.x implementation and organizes them into plannable work units. Each section is self-contained: a model reading this document should be able to plan and implement any section independently.

---

## Table of Contents

1. [Connection State Machine](#1-connection-state-machine)
2. [Composable Router](#2-composable-router)
3. [Request/Response Correlation](#3-requestresponse-correlation)
4. [Idempotency Keys](#4-idempotency-keys)
5. [WorkerClient Responsibility Separation](#5-workerclient-responsibility-separation)
6. [Middleware / Interceptor Pattern](#6-middleware--interceptor-pattern)
7. [Typed Paginated Results](#7-typed-paginated-results)
8. [Streaming & Backpressure](#8-streaming--backpressure)
9. [Schema Versioning](#9-schema-versioning)
10. [Observability Hooks](#10-observability-hooks)

---

## 1. Connection State Machine

### Problem

Connection status is a string enum (`"idle" | "connecting" | "connected" | "disconnected" | "error"`) mutated via imperative `setConnectionStatus()` calls scattered across `WorkerClient`. There are no guards preventing invalid transitions (e.g., `"idle"` → `"disconnected"`) and reconnection logic is interleaved with connection setup.

**Current code (client.ts):**
```typescript
// Transitions happen ad-hoc:
this.callbacks.setConnectionStatus("connecting");   // in connect()
this.callbacks.setConnectionStatus("connected");    // in route() ack handler
this.callbacks.setConnectionStatus("disconnected"); // in scheduleReconnect()
this.callbacks.setConnectionStatus("error", msg);   // in scheduleReconnect() and route()
```

Invalid state transitions are silently possible. For example, calling `retry()` while `"connected"` would create a second WebSocket without closing the first.

### Solution

Replace the string enum with an explicit finite state machine that enforces valid transitions and encapsulates side effects (WebSocket creation, timer management) within transition actions.

**State diagram:**
```
                  connect()
  ┌─────┐  ───────────────>  ┌────────────┐
  │ idle │                   │ connecting  │
  └─────┘  <───────────────  └────────────┘
              disconnect()        │
                                  │ onopen + ack ok
                                  v
                            ┌───────────┐
              disconnect()  │ connected  │
           <────────────── └───────────┘
                                  │
                                  │ onclose (unintentional)
                                  v
                            ┌──────────────┐
              disconnect()  │ reconnecting │ ──> (attempts exhausted) ──> error
           <────────────── └──────────────┘
                                  │
                                  │ onopen + ack ok
                                  v
                            ┌───────────┐
                            │ connected  │
                            └───────────┘
```

**Valid transitions:**
| From           | Event              | To             | Side Effect                          |
|----------------|---------------------|----------------|--------------------------------------|
| `idle`         | `connect()`         | `connecting`   | Create WebSocket                     |
| `connecting`   | `ack.ok`            | `connected`    | Request thread list, resubscribe     |
| `connecting`   | `ack.error`         | `error`        | Close WebSocket                      |
| `connecting`   | `ws.close`          | `reconnecting` | Schedule reconnect timer             |
| `connecting`   | `disconnect()`      | `idle`         | Close WebSocket, clear timers        |
| `connected`    | `ws.close`          | `reconnecting` | Schedule reconnect timer             |
| `connected`    | `disconnect()`      | `idle`         | Close WebSocket                      |
| `reconnecting` | `timer.fire`        | `connecting`   | Create WebSocket (attempt N)         |
| `reconnecting` | `attempts.exhausted`| `error`        | —                                    |
| `reconnecting` | `disconnect()`      | `idle`         | Clear timer                          |
| `error`        | `retry()`           | `connecting`   | Reset attempts, create WebSocket     |
| `error`        | `disconnect()`      | `idle`         | —                                    |

### Implementation Approach

**Client side (`workers-server-client`):**

Create a `ConnectionStateMachine` class that:
- Holds current state as a discriminated union (not a string)
- Exposes a `transition(event)` method that validates the transition
- Throws or logs on invalid transitions during development
- Encapsulates WebSocket lifecycle, timers, and attempt counting
- Emits a single callback (`onStateChange`) consumed by the store

```typescript
type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; ws: WebSocket }
  | { status: "connected"; ws: WebSocket }
  | { status: "reconnecting"; attempt: number; timer: ReturnType<typeof setTimeout> }
  | { status: "error"; error: string; lastAttempt: number };

type ConnectionEvent =
  | { type: "connect"; url: string }
  | { type: "ack_ok" }
  | { type: "ack_error"; message: string }
  | { type: "ws_close" }
  | { type: "timer_fire" }
  | { type: "disconnect" }
  | { type: "retry" };
```

**Server side (`workers-server`):**
No changes needed — the server doesn't track client connection state.

### Files to Change

| File | Change |
|------|--------|
| Create: `src/connection.ts` | `ConnectionStateMachine` class |
| Modify: `src/client.ts` | Replace inline connection logic with state machine |
| Modify: `src/store.ts` | Simplify connection state (remove `reconnectAttempts`, `reconnectFailed` — they move to the state machine) |
| Modify: `src/hooks/use-connection.ts` | Update to read from simplified store |
| Modify: `tests/client.test.ts` | Test transitions and invalid transition guards |

### Dependencies

None — this is a standalone refactor.

---

## 2. Composable Router

### Problem

The `route()` method in `WorkerClient` is a monolithic switch statement that grows with every new frame type. Adding a new S2C frame requires modifying the same method, increasing merge conflicts and making it impossible for consumers to extend routing.

**Current code (client.ts:294-428):**
```typescript
private route(frame: ServerToClient) {
  switch (frame.type) {
    case "ack": { /* 20 lines */ }
    case "thread.list.result": { /* 15 lines */ }
    case "thread.snapshot": { /* 15 lines */ }
    case "event.append": { /* 20 lines */ }
    case "event.list.result": { /* 8 lines */ }
    case "thread.upsert": { /* 1 line */ }
    case "thread.deleted": { /* 3 lines */ }
    case "run.upsert": { /* 1 line */ }
    case "settings.snapshot": { /* 4 lines */ }
    case "settings.patch": { /* 5 lines */ }
    case "feedback.ack": { /* 5 lines */ }
    case "analytics.event": { /* 1 line */ }
    // ... every new frame adds here
  }
}
```

Similarly on the server side, `router.py` has a growing match statement.

### Solution

Replace the switch with a handler registry. Each frame type maps to a handler function. Handlers are registered at construction time, and consumers can add custom handlers.

**Client side:**

```typescript
type FrameHandler<T extends ServerToClient["type"]> = (
  frame: Extract<ServerToClient, { type: T }>,
  context: RouteContext,
) => void;

interface RouteContext {
  store: WorkerActions;
  client: WorkerClient;
  send: (type: string, payload: unknown) => void;
}

class FrameRouter {
  private handlers = new Map<string, FrameHandler<any>>();

  on<T extends ServerToClient["type"]>(type: T, handler: FrameHandler<T>): this {
    this.handlers.set(type, handler);
    return this;
  }

  route(frame: ServerToClient, context: RouteContext): void {
    const handler = this.handlers.get(frame.type);
    if (handler) handler(frame as any, context);
  }
}
```

Default handlers are registered in a factory function. Consumers can override or extend:

```typescript
const router = createDefaultRouter();
router.on("custom.frame", (frame, ctx) => { /* custom logic */ });
```

**Server side (`workers-server`):**

Same pattern — replace the `match` statement in `router.py` with a handler registry:

```python
class FrameRouter:
    def __init__(self):
        self._handlers: dict[str, Callable] = {}

    def on(self, frame_type: str, handler: Callable) -> None:
        self._handlers[frame_type] = handler

    async def route(self, ws, frame, context):
        handler = self._handlers.get(frame.type)
        if handler:
            await handler(ws, frame, context)
```

### Files to Change

| File | Change |
|------|--------|
| Create: `src/router.ts` (client) | `FrameRouter` class + `createDefaultRouter()` factory |
| Modify: `src/client.ts` | Replace `route()` switch with router dispatch |
| Create: `workers-server/src/dooers/handlers/frame_router.py` | `FrameRouter` class |
| Modify: `workers-server/src/dooers/handlers/router.py` | Replace match with registry |

### Dependencies

None — standalone refactor. Can be done before or after other items.

---

## 3. Request/Response Correlation

### Problem

The SDK sends frames with `id` fields but never correlates responses to requests. The only correlation is the connect frame `ack` check. This means:
- No way to detect if a `thread.list` request timed out
- No way to return a promise from `sendMessage()` that resolves when the server acknowledges
- No way to provide per-request error callbacks
- `loadMoreThreads()` uses a boolean flag (`isLoadingMore`) instead of correlating request/response IDs

**Current code (client.ts):**
```typescript
// Fire-and-forget pattern everywhere:
private send(type: string, payload: unknown) {
  this.sendRaw({ id: crypto.randomUUID(), type, payload });
  // id is generated but never tracked
}
```

### Solution

Introduce a pending request registry that tracks outgoing frame IDs and resolves/rejects when the corresponding `ack` or result frame arrives.

```typescript
interface PendingRequest<T = unknown> {
  frameId: string;
  type: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RequestTracker {
  private pending = new Map<string, PendingRequest>();
  private resultTypes = new Map<string, string>(); // "thread.list" → "thread.list.result"

  send<T>(ws: WebSocket, type: string, payload: unknown, timeout = 30000): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${type} timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { frameId: id, type, resolve, reject, timer });
      ws.send(JSON.stringify({ id, type, payload }));
    });
  }

  resolve(frameId: string, result: unknown): boolean {
    const req = this.pending.get(frameId);
    if (!req) return false;
    clearTimeout(req.timer);
    this.pending.delete(frameId);
    req.resolve(result);
    return true;
  }

  reject(frameId: string, error: Error): boolean {
    const req = this.pending.get(frameId);
    if (!req) return false;
    clearTimeout(req.timer);
    this.pending.delete(frameId);
    req.reject(error);
    return true;
  }

  clear(): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error("Connection closed"));
    }
    this.pending.clear();
  }
}
```

**Server side:**

The server already returns `ack` frames with `ack_id` matching the request `id`. For result frames (`thread.list.result`, `event.list.result`), the server needs to forward the original request `id` (or a correlation `ack_id`) in the result payload.

**Changes to server protocol:**
```python
# In thread.list.result, include the request_id:
class ThreadListResultPayload(BaseModel):
    request_id: str | None = None  # correlates to original thread.list frame id
    threads: list[Thread]
    cursor: str | None = None
    total_count: int = 0
```

### Impact on Consumer API

This enables a promise-based API for operations that currently fire-and-forget:

```typescript
// Before (v1):
client.sendMessage({ text: "hello", threadId: "t1" });
// No way to know if it succeeded

// After (v2):
await client.sendMessage({ text: "hello", threadId: "t1" });
// Resolves when server acks, rejects on timeout or error
```

### Files to Change

| File | Change |
|------|--------|
| Create: `src/request-tracker.ts` (client) | `RequestTracker` class |
| Modify: `src/client.ts` | Use tracker for all sends |
| Modify: `workers-server/src/dooers/protocol/frames.py` | Add `request_id` to result payloads |
| Modify: `workers-server/src/dooers/handlers/router.py` | Forward request ID in responses |

### Dependencies

- Benefits from [Composable Router](#2-composable-router) but not required.

---

## 4. Idempotency Keys

### Problem

Only `event.create` uses a `client_event_id` for deduplication. Other mutating operations (`thread.delete`, `settings.patch`, `feedback`) have no idempotency protection. If a reconnection occurs mid-flight, duplicate operations may execute.

### Solution

Extend the `client_event_id` pattern to all mutating C2S frames.

**Protocol change — all C2S frames gain an optional `idempotency_key`:**
```python
# Server: base frame model
class BaseC2SFrame(BaseModel):
    id: str
    type: str
    idempotency_key: str | None = None
```

The server stores processed `idempotency_key` values in a short-lived cache (5-minute TTL) keyed by `(worker_id, idempotency_key)`. If a duplicate arrives, the server returns the cached response without re-executing.

**Client side:**
```typescript
// The client automatically generates idempotency keys for mutating operations:
deleteThread(threadId: string) {
  const key = `delete-${threadId}-${Date.now()}`;
  this.send("thread.delete", { thread_id: threadId }, { idempotencyKey: key });
}
```

### Server-Side Idempotency Cache

```python
class IdempotencyCache:
    """In-memory cache with TTL for processed idempotency keys."""

    def __init__(self, ttl_seconds: int = 300):
        self._cache: dict[str, tuple[float, Any]] = {}
        self._ttl = ttl_seconds

    def get(self, key: str) -> Any | None:
        entry = self._cache.get(key)
        if entry and time.monotonic() - entry[0] < self._ttl:
            return entry[1]
        if entry:
            del self._cache[key]
        return None

    def set(self, key: str, response: Any) -> None:
        self._cache[key] = (time.monotonic(), response)
        self._gc()

    def _gc(self) -> None:
        now = time.monotonic()
        expired = [k for k, (t, _) in self._cache.items() if now - t >= self._ttl]
        for k in expired:
            del self._cache[k]
```

### Files to Change

| File | Change |
|------|--------|
| Modify: `workers-server/src/dooers/protocol/frames.py` | Add `idempotency_key` to C2S base |
| Create: `workers-server/src/dooers/handlers/idempotency.py` | `IdempotencyCache` class |
| Modify: `workers-server/src/dooers/handlers/router.py` | Check cache before handling mutating frames |
| Modify: `src/client.ts` | Generate idempotency keys for mutating operations |
| Modify: `src/protocol/frames.ts` | Add `idempotency_key?` to C2S frame base |

### Dependencies

- Benefits from [Request/Response Correlation](#3-requestresponse-correlation) for caching responses.

---

## 5. WorkerClient Responsibility Separation

### Problem

`WorkerClient` currently handles 5 distinct concerns in a single 450-line class:
1. WebSocket lifecycle (create, open, close, reconnect)
2. Authentication (connect frame, ack handling)
3. Frame routing (S2C → store actions)
4. Public API (subscribe, sendMessage, loadMore, etc.)
5. Internal bookkeeping (subscription refs, pagination cursors, optimistic tracking, last event IDs)

This makes the class hard to test in isolation and difficult to extend.

### Solution

Split `WorkerClient` into focused modules:

```
┌──────────────────────────────────────────────────┐
│  WorkerClient (thin orchestrator)                │
│  - Public API surface                            │
│  - Delegates to sub-modules                      │
├──────────────────────────────────────────────────┤
│  ConnectionManager        │  FrameRouter         │
│  - WebSocket lifecycle    │  - Handler registry  │
│  - State machine          │  - Default handlers  │
│  - Reconnection           │  - Custom handlers   │
├───────────────────────────┼──────────────────────┤
│  SubscriptionManager      │  RequestTracker      │
│  - Ref counting           │  - Pending requests  │
│  - Last event IDs         │  - Timeout handling  │
│  - Resubscribe on         │  - Correlation       │
│    reconnect              │                      │
├───────────────────────────┼──────────────────────┤
│  PaginationTracker        │  OptimisticManager   │
│  - Thread list cursor     │  - Pending optimistic│
│  - Event cursors          │  - Reconciliation    │
│  - Load more state        │  - Client event IDs  │
└───────────────────────────┴──────────────────────┘
```

Each module:
- Has a single responsibility
- Is independently testable
- Communicates via well-defined interfaces
- Can be replaced or extended without affecting others

### Implementation Approach

```typescript
// WorkerClient becomes a thin coordinator:
class WorkerClient {
  readonly connection: ConnectionManager;
  readonly router: FrameRouter;
  readonly subscriptions: SubscriptionManager;
  readonly requests: RequestTracker;
  readonly pagination: PaginationTracker;
  readonly optimistic: OptimisticManager;

  constructor(callbacks: WorkerActions, options?: WorkerClientOptions) {
    this.connection = new ConnectionManager(/* ... */);
    this.router = createDefaultRouter();
    this.subscriptions = new SubscriptionManager();
    this.requests = new RequestTracker();
    this.pagination = new PaginationTracker();
    this.optimistic = new OptimisticManager(callbacks);

    // Wire connection events to router
    this.connection.onMessage = (frame) => this.router.route(frame, this.context);
    this.connection.onConnected = () => this.onConnected();
    this.connection.onDisconnected = () => this.requests.clear();
  }

  // Public API methods delegate to sub-modules
  subscribe(threadId: string) { this.subscriptions.add(threadId, this); }
  sendMessage(params: SendMessageParams) { this.optimistic.send(params, this); }
  loadMoreThreads(limit?: number) { this.pagination.loadMore(this, limit); }
}
```

### Files to Change

| File | Change |
|------|--------|
| Create: `src/connection.ts` | `ConnectionManager` (from item 1) |
| Create: `src/router.ts` | `FrameRouter` (from item 2) |
| Create: `src/request-tracker.ts` | `RequestTracker` (from item 3) |
| Create: `src/subscriptions.ts` | `SubscriptionManager` |
| Create: `src/pagination.ts` | `PaginationTracker` |
| Create: `src/optimistic.ts` | `OptimisticManager` |
| Modify: `src/client.ts` | Thin orchestrator wrapping sub-modules |

### Dependencies

- Should be done after items 1, 2, 3 since those create the modules this item composes.

---

## 6. Middleware / Interceptor Pattern

### Problem

There is no way for consumers to intercept, transform, or observe frames as they flow through the system. Common needs:
- Logging all frames in development
- Adding auth tokens to outgoing frames
- Transforming or enriching incoming frames
- Implementing custom retry logic per frame type
- Rate-limiting outgoing frames

### Solution

Add a middleware pipeline for both outgoing (C2S) and incoming (S2C) frames.

```typescript
type OutgoingMiddleware = (
  frame: { type: string; payload: unknown },
  next: () => void,
) => void;

type IncomingMiddleware = (
  frame: ServerToClient,
  next: () => void,
) => void;

interface MiddlewareStack {
  useOutgoing(middleware: OutgoingMiddleware): void;
  useIncoming(middleware: IncomingMiddleware): void;
}
```

**Example — development logger:**
```typescript
client.useIncoming((frame, next) => {
  console.log("[S2C]", frame.type, frame.payload);
  next();
});

client.useOutgoing((frame, next) => {
  console.log("[C2S]", frame.type, frame.payload);
  next();
});
```

**Example — auth token injector:**
```typescript
client.useOutgoing((frame, next) => {
  frame.payload = { ...frame.payload, auth_token: getToken() };
  next();
});
```

**Example — rate limiter:**
```typescript
const rateLimiter = createRateLimiter({ maxPerSecond: 10 });
client.useOutgoing((frame, next) => {
  rateLimiter.acquire().then(next);
});
```

### Files to Change

| File | Change |
|------|--------|
| Create: `src/middleware.ts` | `MiddlewareStack` class |
| Modify: `src/client.ts` | Run middleware before send / after receive |
| Create: `src/middleware/logger.ts` | Built-in dev logger middleware |

### Dependencies

- Benefits from [Composable Router](#2-composable-router) and [WorkerClient Separation](#5-workerclient-responsibility-separation).

---

## 7. Typed Paginated Results

### Problem

Pagination state is tracked ad-hoc with loose types. Thread pagination uses raw `string | null` cursor and `boolean` hasMore scattered across store fields. Event pagination uses a `Record<string, { cursor: string | null; hasMore: boolean }>`. There's no shared pattern.

### Solution

Define a generic `PaginatedResult<T>` type and a `PaginationState` that both thread and event pagination use.

```typescript
interface PaginationState {
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  totalCount?: number;
}

interface PaginatedList<T> {
  items: T[];
  pagination: PaginationState;
  loadMore: (limit?: number) => void;
}
```

**Store changes:**
```typescript
interface WorkerState {
  // Replace scattered fields:
  // threadListCursor, threadListHasMore, threadListTotalCount
  // With:
  threadPagination: PaginationState;

  // eventPagination stays Record-based but uses the same type:
  eventPagination: Record<string, PaginationState>;
}
```

**Hook changes:**
```typescript
// useThreads returns a PaginatedList:
function useThreads(): PaginatedList<Thread> & { deleteThread: (id: string) => void } {
  // ...
  return {
    items: threads,
    pagination: { cursor, hasMore, isLoading, totalCount },
    loadMore,
    deleteThread,
  };
}

// useThreadEvents returns pagination-aware state:
function useThreadEvents(threadId: string | null): {
  hasOlderEvents: boolean;
  isLoadingOlder: boolean;
  loadOlderEvents: (limit?: number) => void;
} {
  // ...
}
```

### Files to Change

| File | Change |
|------|--------|
| Modify: `src/types.ts` | Add `PaginationState`, `PaginatedList<T>` |
| Modify: `src/store.ts` | Use `PaginationState` for thread and event pagination |
| Modify: `src/hooks/use-threads.ts` | Return `PaginatedList<Thread>` |
| Modify: `src/hooks/use-thread.ts` | Use `PaginationState` for event pagination |

### Dependencies

None — standalone refactor.

---

## 8. Streaming & Backpressure

### Problem

The SDK processes all incoming frames synchronously and immediately. If the server sends a burst of events (e.g., 500 `event.append` frames during a bulk import), the client:
1. Parses all 500 frames synchronously
2. Triggers 500 Zustand state updates
3. Causes 500 React re-renders (or however many the React batching captures)

There's also no server-side backpressure — the server pushes frames without regard for client consumption rate.

### Solution

#### Client-Side Frame Batching

Buffer incoming frames and flush on `requestAnimationFrame` or `queueMicrotask`:

```typescript
class FrameBuffer {
  private queue: ServerToClient[] = [];
  private scheduled = false;

  push(frame: ServerToClient) {
    this.queue.push(frame);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush() {
    this.scheduled = false;
    const batch = this.queue;
    this.queue = [];
    // Process all frames, merge state updates into a single Zustand batch
    for (const frame of batch) {
      this.router.route(frame, this.context);
    }
  }
}
```

#### Store Batch Updates

Wrap multiple store mutations in a single Zustand update to minimize re-renders:

```typescript
// Instead of N individual set() calls:
store.setState((s) => {
  let state = s;
  for (const frame of batch) {
    state = applyFrame(state, frame);
  }
  return state;
});
```

#### Server-Side Backpressure (Future)

For high-throughput scenarios, the server could implement flow control:
- Client sends a `flow.control` frame with `max_pending: N`
- Server pauses sending when N unacknowledged frames are in flight
- Client acknowledges batches periodically

This is a future enhancement — client-side batching should handle most cases.

### Files to Change

| File | Change |
|------|--------|
| Create: `src/frame-buffer.ts` | `FrameBuffer` class |
| Modify: `src/client.ts` | Route through buffer instead of direct dispatch |
| Modify: `src/store.ts` | Add batch-aware update methods |

### Dependencies

- Benefits from [Composable Router](#2-composable-router) for frame processing.

---

## 9. Schema Versioning

### Problem

There is no protocol version negotiation. If the server adds a field to a frame payload, older clients silently ignore it. If the server removes a field, older clients break. There's no way to:
- Detect client/server version mismatch
- Gracefully degrade when versions differ
- Roll out breaking protocol changes incrementally

### Solution

Add protocol version to the `connect` frame handshake.

**Connect frame change:**
```typescript
// Client sends:
{
  type: "connect",
  payload: {
    worker_id: "...",
    protocol_version: "2.0",
    min_protocol_version: "1.0",
    client: { name: "workers-server-client", version: "2.0.0" },
    // ...
  }
}
```

**Server ack response:**
```python
# Server responds:
{
  "type": "ack",
  "payload": {
    "ok": true,
    "protocol_version": "2.0",  # version the server will use for this session
    "ack_id": "..."
  }
}
```

**Version negotiation rules:**
1. Client sends `protocol_version` (preferred) and `min_protocol_version` (minimum supported)
2. Server checks if it can serve any version in `[min, preferred]`
3. If yes: responds with the highest mutually supported version
4. If no: responds with `ok: false` and an error code `PROTOCOL_VERSION_MISMATCH`

**Client-side version-aware routing:**
```typescript
// After negotiation, the client can adapt behavior:
if (negotiatedVersion >= "2.0") {
  router.on("thread.list.result", handleV2ThreadList);
} else {
  router.on("thread.list.result", handleV1ThreadList);
}
```

### Files to Change

| File | Change |
|------|--------|
| Modify: `src/client.ts` | Send protocol version in connect, store negotiated version |
| Modify: `src/protocol/frames.ts` | Add version fields to connect/ack |
| Modify: `workers-server/src/dooers/protocol/frames.py` | Add version fields |
| Modify: `workers-server/src/dooers/handlers/router.py` | Version negotiation in ack handler |

### Dependencies

None — can be implemented independently.

---

## 10. Observability Hooks

### Problem

There are no hooks for monitoring SDK health in production. Consumers can't track:
- Frame latency (time between send and ack)
- Reconnection frequency and duration
- Frame throughput (frames/second in each direction)
- Error rates by frame type
- Store update frequency

The `onError` callback only covers protocol errors, not operational metrics.

### Solution

Add an `onMetrics` callback to the provider that receives structured telemetry events.

```typescript
interface WorkerProviderProps {
  // ... existing props
  onMetrics?: (metric: WorkerMetric) => void;
}

type WorkerMetric =
  | { type: "frame.sent"; frameType: string; timestamp: number }
  | { type: "frame.received"; frameType: string; timestamp: number }
  | { type: "frame.latency"; frameType: string; requestId: string; latencyMs: number }
  | { type: "connection.state_change"; from: string; to: string; timestamp: number }
  | { type: "connection.reconnect"; attempt: number; delayMs: number }
  | { type: "store.update"; actionName: string; durationMs: number }
  | { type: "error"; code: string; message: string; frameType?: string };
```

**Consumer usage:**
```typescript
<WorkerProvider
  url="wss://..."
  workerId="w1"
  onMetrics={(metric) => {
    // Send to your telemetry provider
    analytics.track(metric.type, metric);
  }}
>
```

**Implementation:**

The metrics emitter is a simple function passed through the system:

```typescript
class WorkerClient {
  private emit: (metric: WorkerMetric) => void;

  constructor(callbacks: WorkerActions, emit?: (m: WorkerMetric) => void) {
    this.emit = emit ?? (() => {});
  }

  private send(type: string, payload: unknown) {
    this.emit({ type: "frame.sent", frameType: type, timestamp: Date.now() });
    this.sendRaw({ id: crypto.randomUUID(), type, payload });
  }

  private route(frame: ServerToClient) {
    this.emit({ type: "frame.received", frameType: frame.type, timestamp: Date.now() });
    // ... route as normal
  }
}
```

### Files to Change

| File | Change |
|------|--------|
| Create: `src/metrics.ts` | `WorkerMetric` types, `MetricsEmitter` utility |
| Modify: `src/client.ts` | Emit metrics on send/receive/connect/disconnect |
| Modify: `src/provider.tsx` | Accept and pass `onMetrics` prop |
| Modify: `src/store.ts` | Optionally emit metrics on store updates |

### Dependencies

- Benefits from [Connection State Machine](#1-connection-state-machine) for state change metrics.
- Benefits from [Request/Response Correlation](#3-requestresponse-correlation) for latency metrics.

---

## Implementation Order

These improvements have natural dependency chains. The recommended implementation order:

```
Phase 1: Foundation (no breaking changes)
├── 1. Connection State Machine
├── 2. Composable Router
├── 9. Schema Versioning
└── 7. Typed Paginated Results

Phase 2: Core Infrastructure
├── 3. Request/Response Correlation  (needs: 2)
├── 10. Observability Hooks          (benefits from: 1, 3)
└── 4. Idempotency Keys             (benefits from: 3)

Phase 3: Architecture
├── 5. WorkerClient Separation       (needs: 1, 2, 3)
├── 6. Middleware Pattern            (needs: 2, 5)
└── 8. Streaming & Backpressure     (benefits from: 2, 5)
```

**Phase 1** items are independent and can be parallelized. They establish the patterns that Phase 2 and 3 build on.

**Phase 2** items depend on the router and state machine from Phase 1.

**Phase 3** items compose everything together into the final architecture.

---

## Breaking Changes Summary

| Item | Breaking? | Migration |
|------|-----------|-----------|
| 1. Connection State Machine | No | Internal refactor, same public API |
| 2. Composable Router | No | Internal refactor + new extension point |
| 3. Request/Response Correlation | Minor | `sendMessage` returns `Promise` (was `void`) |
| 4. Idempotency Keys | No | Additive protocol change |
| 5. WorkerClient Separation | No | Internal refactor |
| 6. Middleware Pattern | No | New API surface, opt-in |
| 7. Typed Paginated Results | Yes | `useThreads()` return shape changes |
| 8. Streaming & Backpressure | No | Internal optimization |
| 9. Schema Versioning | No | Backward-compatible protocol addition |
| 10. Observability Hooks | No | New opt-in prop |

Only items **3** and **7** have consumer-facing API changes. The rest are internal refactors or additive features.

---

## Success Criteria

After v2.0.0, the SDK should:
- Handle 5000+ threads and 10000+ events per thread without degradation
- Detect and recover from every invalid state transition
- Allow consumers to extend frame handling without forking
- Correlate every request with its response (timeout detection, latency measurement)
- Never execute duplicate mutations on reconnection
- Provide production observability out of the box
- Support incremental protocol upgrades without breaking clients
- Batch high-throughput frame processing to maintain 60fps UI
