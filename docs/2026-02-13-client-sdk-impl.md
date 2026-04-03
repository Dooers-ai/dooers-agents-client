# agents-server-client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a React SDK (`agents-server-client`) that provides `<AgentProvider>` + hooks for real-time communication with agents-server backends over WebSocket.

**Architecture:** Three layers — vanilla JS WebSocket client, Zustand store (normalized state), React hooks. The client handles frames and reconnection, the store holds normalized threads/events/runs, hooks are thin selectors with auto-subscribe.

**Tech Stack:** TypeScript, React 18/19, Zustand 5, tsup (build), Vitest (test), Biome (lint/format)

**Design doc:** `docs/2026-02-13-client-sdk-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `biome.json`
- Create: `src/main.ts` (placeholder)

**Step 1: Initialize git and create package.json**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git init
```

Create `package.json`:

```json
{
  "name": "agents-server-client",
  "version": "0.1.0",
  "description": "React SDK for agents-server",
  "type": "module",
  "main": "./dist/main.cjs",
  "module": "./dist/main.js",
  "types": "./dist/main.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/main.d.ts",
        "default": "./dist/main.js"
      },
      "require": {
        "types": "./dist/main.d.cts",
        "default": "./dist/main.cjs"
      }
    }
  },
  "files": ["dist"],
  "sideEffects": false,
  "scripts": {
    "build": "tsup",
    "check": "biome check .",
    "check:fix": "biome check --fix .",
    "format": "biome format --write .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0"
  },
  "dependencies": {
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^19.0.0",
    "jsdom": "^25.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create tsup.config.ts**

```ts
import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom"],
  treeshake: true,
})
```

**Step 4: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
```

**Step 5: Create vitest config**

Add to `tsconfig.json` — no separate vitest config needed, add to package.json:

Actually, create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
  },
})
```

**Step 6: Create placeholder src/main.ts**

```ts
export {}
```

**Step 7: Install dependencies and verify**

```bash
npm install
npx tsc --noEmit
npx tsup
```

**Step 8: Create .gitignore and commit**

```
node_modules/
dist/
```

```bash
git add .
git commit -m "chore: scaffold agents-server-client package"
```

---

### Task 2: Protocol Types

**Files:**
- Create: `src/protocol/models.ts`
- Create: `src/protocol/frames.ts`
- Create: `src/types.ts`

These are pure type definitions matching the backend protocol. camelCase on our side, with a `toCamel`/`toSnake` utility in frames.

**Step 1: Create protocol models**

Create `src/protocol/models.ts` — the wire format types (snake_case, matching server JSON):

```ts
// Wire format types — snake_case, matching the server's JSON exactly.
// These are internal. Public types in types.ts use camelCase.

export interface WireThread {
  id: string
  agent_id: string
  organization_id: string
  workspace_id: string
  user_id: string
  title: string | null
  created_at: string
  updated_at: string
  last_event_at: string
}

export interface WireTextPart {
  type: "text"
  text: string
}

export interface WireImagePart {
  type: "image"
  url: string
  mime_type?: string
  width?: number
  height?: number
  alt?: string
}

export interface WireDocumentPart {
  type: "document"
  url: string
  filename: string
  mime_type: string
  size_bytes?: number
}

export type WireContentPart = WireTextPart | WireImagePart | WireDocumentPart

export type WireActor = "user" | "assistant" | "system" | "tool"
export type WireEventType =
  | "message"
  | "run.started"
  | "run.finished"
  | "tool.call"
  | "tool.result"
  | "tool.transaction"
export type WireRunStatus = "running" | "succeeded" | "failed" | "canceled"

export interface WireThreadEvent {
  id: string
  thread_id: string
  run_id: string | null
  type: WireEventType
  actor: WireActor
  author: string | null
  user_id: string | null
  user_name: string | null
  user_email: string | null
  content?: WireContentPart[]
  data?: Record<string, unknown>
  created_at: string
  streaming?: boolean
  finalized?: boolean
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
```

**Step 2: Create frame types**

Create `src/protocol/frames.ts`:

```ts
import type {
  WireContentPart,
  WireRun,
  WireThread,
  WireThreadEvent,
} from "./models"

// --- Frame wrapper ---

export interface Frame<T extends string, P = unknown> {
  id: string
  type: T
  payload: P
}

// --- Client to Server (C2S) ---

export type C2S_Connect = Frame<
  "connect",
  {
    agent_id: string
    organization_id: string
    workspace_id: string
    user_id: string
    user_name: string
    user_email: string
    user_role: string
    auth_token?: string
    client?: { name: string; version: string }
  }
>

export type C2S_ThreadList = Frame<
  "thread.list",
  { cursor?: string | null; limit?: number }
>

export type C2S_ThreadSubscribe = Frame<
  "thread.subscribe",
  { thread_id: string; after_event_id?: string | null }
>

export type C2S_ThreadUnsubscribe = Frame<
  "thread.unsubscribe",
  { thread_id: string }
>

export type C2S_ThreadDelete = Frame<
  "thread.delete",
  { thread_id: string }
>

export type C2S_EventCreate = Frame<
  "event.create",
  {
    thread_id?: string
    client_event_id?: string
    event: {
      type: "message"
      actor: "user"
      content: WireContentPart[]
      data?: Record<string, unknown>
    }
  }
>

export type ClientToServer =
  | C2S_Connect
  | C2S_ThreadList
  | C2S_ThreadSubscribe
  | C2S_ThreadUnsubscribe
  | C2S_ThreadDelete
  | C2S_EventCreate

// --- Server to Client (S2C) ---

export type S2C_Ack = Frame<
  "ack",
  { ack_id: string; ok: boolean; error?: { code: string; message: string } }
>

export type S2C_ThreadListResult = Frame<
  "thread.list.result",
  { threads: WireThread[]; cursor?: string | null }
>

export type S2C_ThreadSnapshot = Frame<
  "thread.snapshot",
  { thread: WireThread; events: WireThreadEvent[]; runs?: WireRun[] }
>

export type S2C_EventAppend = Frame<
  "event.append",
  { thread_id: string; events: WireThreadEvent[] }
>

export type S2C_ThreadUpsert = Frame<
  "thread.upsert",
  { thread: WireThread }
>

export type S2C_ThreadDeleted = Frame<
  "thread.deleted",
  { thread_id: string }
>

export type S2C_RunUpsert = Frame<
  "run.upsert",
  { run: WireRun }
>

export type ServerToClient =
  | S2C_Ack
  | S2C_ThreadListResult
  | S2C_ThreadSnapshot
  | S2C_EventAppend
  | S2C_ThreadUpsert
  | S2C_ThreadDeleted
  | S2C_RunUpsert
```

**Step 3: Create public types + transform utilities**

Create `src/types.ts`:

```ts
// --- Public types (camelCase) ---

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image"
  url: string
  mimeType?: string
  alt?: string
}

export interface DocumentPart {
  type: "document"
  url: string
  filename: string
  mimeType: string
}

export type ContentPart = TextPart | ImagePart | DocumentPart

export type Actor = "user" | "assistant" | "system" | "tool"
export type EventType =
  | "message"
  | "run.started"
  | "run.finished"
  | "tool.call"
  | "tool.result"
  | "tool.transaction"
export type RunStatus = "running" | "succeeded" | "failed" | "canceled"
export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error"

export interface Thread {
  id: string
  agentId: string
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
  userId: string | null
  userName: string | null
  userEmail: string | null
  content?: ContentPart[]
  data?: Record<string, unknown>
  createdAt: string
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

export interface ThreadState {
  thread: Thread | null
  events: ThreadEvent[]
  runs: Run[]
  isLoading: boolean
}

// --- Wire → Public transforms ---

import type {
  WireContentPart,
  WireRun,
  WireThread,
  WireThreadEvent,
} from "./protocol/models"

export function toThread(w: WireThread): Thread {
  return {
    id: w.id,
    agentId: w.agent_id,
    title: w.title,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    lastEventAt: w.last_event_at,
  }
}

export function toContentPart(w: WireContentPart): ContentPart {
  switch (w.type) {
    case "text":
      return { type: "text", text: w.text }
    case "image":
      return { type: "image", url: w.url, mimeType: w.mime_type, alt: w.alt }
    case "document":
      return { type: "document", url: w.url, filename: w.filename, mimeType: w.mime_type }
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
    userId: w.user_id,
    userName: w.user_name,
    userEmail: w.user_email,
    content: w.content?.map(toContentPart),
    data: w.data,
    createdAt: w.created_at,
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

// --- Public → Wire transforms (for sending content) ---

export function toWireContentPart(p: ContentPart): WireContentPart {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text }
    case "image":
      return { type: "image", url: p.url, mime_type: p.mimeType, alt: p.alt }
    case "document":
      return { type: "document", url: p.url, filename: p.filename, mime_type: p.mimeType }
  }
}
```

**Step 4: Verify types compile**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/protocol src/types.ts
git commit -m "feat: add protocol types and wire transforms"
```

---

### Task 3: Zustand Store

**Files:**
- Create: `src/store.ts`
- Create: `tests/store.test.ts`

The store is pure state management — no async, no WebSocket. All actions are synchronous state transitions.

**Step 1: Write store tests**

Create `tests/store.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createAgentStore } from "../src/store"
import type { Thread, ThreadEvent, Run } from "../src/types"

const thread = (id: string, lastEventAt = "2026-01-01T00:00:00Z"): Thread => ({
  id,
  agentId: "w1",
  title: `Thread ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastEventAt,
})

const event = (id: string, threadId: string, actor: "user" | "assistant" = "user"): ThreadEvent => ({
  id,
  threadId,
  runId: null,
  type: "message",
  actor,
  author: null,
  userId: "u1",
  userName: "Alice",
  userEmail: "alice@test.com",
  content: [{ type: "text", text: `Message ${id}` }],
  createdAt: "2026-01-01T00:00:00Z",
})

const run = (id: string, threadId: string, status: "running" | "succeeded" = "running"): Run => ({
  id,
  threadId,
  agentId: "agent-1",
  status,
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  error: null,
})

describe("createAgentStore", () => {
  it("starts with idle connection", () => {
    const store = createAgentStore()
    expect(store.getState().connection.status).toBe("idle")
  })

  it("setConnectionStatus updates status and error", () => {
    const store = createAgentStore()
    store.getState().actions.setConnectionStatus("error", "fail")
    expect(store.getState().connection.status).toBe("error")
    expect(store.getState().connection.error).toBe("fail")
  })

  it("onThreadList populates threads and threadOrder", () => {
    const store = createAgentStore()
    const t1 = thread("t1", "2026-01-02T00:00:00Z")
    const t2 = thread("t2", "2026-01-03T00:00:00Z")
    store.getState().actions.onThreadList([t2, t1])
    expect(Object.keys(store.getState().threads)).toEqual(["t2", "t1"])
    expect(store.getState().threadOrder).toEqual(["t2", "t1"])
  })

  it("onThreadUpsert adds new thread", () => {
    const store = createAgentStore()
    store.getState().actions.onThreadUpsert(thread("t1"))
    expect(store.getState().threads["t1"]).toBeDefined()
    expect(store.getState().threadOrder).toContain("t1")
  })

  it("onThreadUpsert updates existing thread", () => {
    const store = createAgentStore()
    store.getState().actions.onThreadUpsert(thread("t1"))
    store.getState().actions.onThreadUpsert({ ...thread("t1"), title: "Updated" })
    expect(store.getState().threads["t1"]?.title).toBe("Updated")
  })

  it("onThreadDeleted removes thread and its events/runs", () => {
    const store = createAgentStore()
    store.getState().actions.onThreadUpsert(thread("t1"))
    store.getState().actions.onThreadSnapshot(thread("t1"), [event("e1", "t1")], [run("r1", "t1")])
    store.getState().actions.onThreadDeleted("t1")
    expect(store.getState().threads["t1"]).toBeUndefined()
    expect(store.getState().events["t1"]).toBeUndefined()
    expect(store.getState().runs["t1"]).toBeUndefined()
  })

  it("onThreadSnapshot sets events and runs for a thread", () => {
    const store = createAgentStore()
    const t = thread("t1")
    const e = [event("e1", "t1"), event("e2", "t1")]
    const r = [run("r1", "t1")]
    store.getState().actions.onThreadSnapshot(t, e, r)
    expect(store.getState().events["t1"]).toHaveLength(2)
    expect(store.getState().runs["t1"]).toHaveLength(1)
    expect(store.getState().threads["t1"]).toBeDefined()
    expect(store.getState().loadingThreads.has("t1")).toBe(false)
  })

  it("onEventAppend appends and deduplicates events", () => {
    const store = createAgentStore()
    store.getState().actions.onEventAppend("t1", [event("e1", "t1")])
    store.getState().actions.onEventAppend("t1", [event("e1", "t1"), event("e2", "t1")])
    expect(store.getState().events["t1"]).toHaveLength(2)
  })

  it("onRunUpsert adds new run", () => {
    const store = createAgentStore()
    store.getState().actions.onRunUpsert(run("r1", "t1"))
    expect(store.getState().runs["t1"]).toHaveLength(1)
  })

  it("onRunUpsert updates existing run", () => {
    const store = createAgentStore()
    store.getState().actions.onRunUpsert(run("r1", "t1"))
    store.getState().actions.onRunUpsert({ ...run("r1", "t1"), status: "succeeded" })
    expect(store.getState().runs["t1"]?.[0]?.status).toBe("succeeded")
  })

  it("optimistic add and remove", () => {
    const store = createAgentStore()
    const e = event("opt-1", "t1")
    store.getState().actions.addOptimistic("t1", e, "client-1")
    expect(store.getState().optimistic["t1"]).toHaveLength(1)
    store.getState().actions.removeOptimistic("t1", "client-1")
    expect(store.getState().optimistic["t1"]).toHaveLength(0)
  })

  it("subscription tracking", () => {
    const store = createAgentStore()
    store.getState().actions.addSubscription("t1")
    expect(store.getState().subscriptions.has("t1")).toBe(true)
    store.getState().actions.removeSubscription("t1")
    expect(store.getState().subscriptions.has("t1")).toBe(false)
  })

  it("resetReconnect resets attempts and failed flag", () => {
    const store = createAgentStore()
    store.getState().actions.setConnectionStatus("connecting")
    store.getState().actions.setConnectionStatus("disconnected")
    const s = store.getState()
    s.actions.resetReconnect()
    expect(store.getState().connection.reconnectAttempts).toBe(0)
    expect(store.getState().connection.reconnectFailed).toBe(false)
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run
```

Expected: FAIL — `createAgentStore` not found.

**Step 3: Implement the store**

Create `src/store.ts`:

```ts
import { createStore } from "zustand/vanilla"
import type { ContentPart, Run, Thread, ThreadEvent } from "./types"

const OPTIMISTIC_PREFIX = "optimistic-"

export interface AgentActions {
  setConnectionStatus: (status: AgentState["connection"]["status"], error?: string) => void
  resetReconnect: () => void
  onThreadList: (threads: Thread[]) => void
  onThreadUpsert: (thread: Thread) => void
  onThreadDeleted: (threadId: string) => void
  onThreadSnapshot: (thread: Thread, events: ThreadEvent[], runs: Run[]) => void
  onEventAppend: (threadId: string, events: ThreadEvent[]) => void
  onRunUpsert: (run: Run) => void
  addOptimistic: (threadId: string, event: ThreadEvent, clientEventId: string) => void
  removeOptimistic: (threadId: string, clientEventId: string) => void
  addSubscription: (threadId: string) => void
  removeSubscription: (threadId: string) => void
}

export interface AgentState {
  connection: {
    status: "idle" | "connecting" | "connected" | "disconnected" | "error"
    error: string | null
    reconnectAttempts: number
    reconnectFailed: boolean
  }
  threads: Record<string, Thread>
  threadOrder: string[]
  events: Record<string, ThreadEvent[]>
  optimistic: Record<string, ThreadEvent[]>
  optimisticKeys: Record<string, string[]> // threadId → clientEventId[]
  runs: Record<string, Run[]>
  subscriptions: Set<string>
  loadingThreads: Set<string>
  actions: AgentActions
}

export type AgentStore = ReturnType<typeof createAgentStore>

export function createAgentStore() {
  return createStore<AgentState>()((set) => ({
    connection: {
      status: "idle",
      error: null,
      reconnectAttempts: 0,
      reconnectFailed: false,
    },
    threads: {},
    threadOrder: [],
    events: {},
    optimistic: {},
    optimisticKeys: {},
    runs: {},
    subscriptions: new Set(),
    loadingThreads: new Set(),

    actions: {
      setConnectionStatus: (status, error) =>
        set((s) => ({
          connection: { ...s.connection, status, error: error ?? null },
        })),

      resetReconnect: () =>
        set((s) => ({
          connection: { ...s.connection, reconnectAttempts: 0, reconnectFailed: false },
        })),

      onThreadList: (threads) =>
        set(() => {
          const map: Record<string, Thread> = {}
          const order: string[] = []
          for (const t of threads) {
            map[t.id] = t
            order.push(t.id)
          }
          return { threads: map, threadOrder: order }
        }),

      onThreadUpsert: (thread) =>
        set((s) => {
          const threads = { ...s.threads, [thread.id]: thread }
          const threadOrder = s.threadOrder.includes(thread.id)
            ? s.threadOrder
            : [thread.id, ...s.threadOrder]
          return { threads, threadOrder }
        }),

      onThreadDeleted: (threadId) =>
        set((s) => {
          const { [threadId]: _, ...threads } = s.threads
          const { [threadId]: _e, ...events } = s.events
          const { [threadId]: _r, ...runs } = s.runs
          const { [threadId]: _o, ...optimistic } = s.optimistic
          const { [threadId]: _k, ...optimisticKeys } = s.optimisticKeys
          const threadOrder = s.threadOrder.filter((id) => id !== threadId)
          const subscriptions = new Set(s.subscriptions)
          subscriptions.delete(threadId)
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.delete(threadId)
          return { threads, threadOrder, events, runs, optimistic, optimisticKeys, subscriptions, loadingThreads }
        }),

      onThreadSnapshot: (thread, events, runs) =>
        set((s) => {
          const threads = { ...s.threads, [thread.id]: thread }
          const threadOrder = s.threadOrder.includes(thread.id)
            ? s.threadOrder
            : [thread.id, ...s.threadOrder]
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.delete(thread.id)
          return {
            threads,
            threadOrder,
            events: { ...s.events, [thread.id]: events },
            runs: { ...s.runs, [thread.id]: runs },
            loadingThreads,
          }
        }),

      onEventAppend: (threadId, newEvents) =>
        set((s) => {
          const existing = s.events[threadId] ?? []
          const existingIds = new Set(existing.map((e) => e.id))
          const unique = newEvents.filter((e) => !existingIds.has(e.id))
          return {
            events: { ...s.events, [threadId]: [...existing, ...unique] },
          }
        }),

      onRunUpsert: (run) =>
        set((s) => {
          const existing = s.runs[run.threadId] ?? []
          const idx = existing.findIndex((r) => r.id === run.id)
          const updated =
            idx >= 0
              ? existing.map((r) => (r.id === run.id ? run : r))
              : [...existing, run]
          return { runs: { ...s.runs, [run.threadId]: updated } }
        }),

      addOptimistic: (threadId, event, clientEventId) =>
        set((s) => ({
          optimistic: {
            ...s.optimistic,
            [threadId]: [...(s.optimistic[threadId] ?? []), event],
          },
          optimisticKeys: {
            ...s.optimisticKeys,
            [threadId]: [...(s.optimisticKeys[threadId] ?? []), clientEventId],
          },
        })),

      removeOptimistic: (threadId, clientEventId) =>
        set((s) => {
          const keys = s.optimisticKeys[threadId] ?? []
          const idx = keys.indexOf(clientEventId)
          if (idx < 0) return s
          const newKeys = [...keys]
          newKeys.splice(idx, 1)
          const newEvents = [...(s.optimistic[threadId] ?? [])]
          newEvents.splice(idx, 1)
          return {
            optimistic: { ...s.optimistic, [threadId]: newEvents },
            optimisticKeys: { ...s.optimisticKeys, [threadId]: newKeys },
          }
        }),

      addSubscription: (threadId) =>
        set((s) => {
          const subscriptions = new Set(s.subscriptions)
          subscriptions.add(threadId)
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.add(threadId)
          return { subscriptions, loadingThreads }
        }),

      removeSubscription: (threadId) =>
        set((s) => {
          const subscriptions = new Set(s.subscriptions)
          subscriptions.delete(threadId)
          const loadingThreads = new Set(s.loadingThreads)
          loadingThreads.delete(threadId)
          return { subscriptions, loadingThreads }
        }),
    },
  }))
}
```

**Step 4: Run tests**

```bash
npx vitest run
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat: add Zustand store with normalized state"
```

---

### Task 4: AgentClient

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

The client is vanilla JS — no React, no Zustand import. It talks to the store via callbacks.

**Step 1: Write client tests**

Create `tests/client.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest"
import { AgentClient } from "../src/client"
import type { AgentActions } from "../src/store"

function createMockCallbacks(): AgentActions {
  return {
    setConnectionStatus: vi.fn(),
    resetReconnect: vi.fn(),
    onThreadList: vi.fn(),
    onThreadUpsert: vi.fn(),
    onThreadDeleted: vi.fn(),
    onThreadSnapshot: vi.fn(),
    onEventAppend: vi.fn(),
    onRunUpsert: vi.fn(),
    addOptimistic: vi.fn(),
    removeOptimistic: vi.fn(),
    addSubscription: vi.fn(),
    removeSubscription: vi.fn(),
  }
}

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
    // Simulate async open
    setTimeout(() => this.onopen?.(), 0)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  // Test helper: simulate server message
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

describe("AgentClient", () => {
  let callbacks: AgentActions

  beforeEach(() => {
    callbacks = createMockCallbacks()
    MockWebSocket.instances = []
    vi.stubGlobal("WebSocket", MockWebSocket)
  })

  it("sends connect frame on open", async () => {
    const client = new AgentClient(callbacks)
    client.connect("wss://test.com/ws", "w1", {
      organizationId: "org1",
      workspaceId: "ws1",
      user: { id: "u1", name: "Alice", email: "alice@test.com", role: "member" },
    })

    expect(callbacks.setConnectionStatus).toHaveBeenCalledWith("connecting")

    // Wait for async open
    await new Promise((r) => setTimeout(r, 10))

    const ws = MockWebSocket.instances[0]!
    expect(ws.sent).toHaveLength(1)
    const frame = JSON.parse(ws.sent[0]!)
    expect(frame.type).toBe("connect")
    expect(frame.payload.agent_id).toBe("w1")
    expect(frame.payload.organization_id).toBe("org1")
  })

  it("routes ack frame and requests thread list", async () => {
    const client = new AgentClient(callbacks)
    client.connect("wss://test.com/ws", "w1")

    await new Promise((r) => setTimeout(r, 10))

    const ws = MockWebSocket.instances[0]!
    const connectId = JSON.parse(ws.sent[0]!).id

    ws.receive({ id: "ack-1", type: "ack", payload: { ack_id: connectId, ok: true } })

    expect(callbacks.setConnectionStatus).toHaveBeenCalledWith("connected")
    expect(callbacks.resetReconnect).toHaveBeenCalled()
    // Should have sent thread.list
    expect(ws.sent).toHaveLength(2)
    expect(JSON.parse(ws.sent[1]!).type).toBe("thread.list")
  })

  it("routes thread.list.result", async () => {
    const client = new AgentClient(callbacks)
    client.connect("wss://test.com/ws", "w1")
    await new Promise((r) => setTimeout(r, 10))

    const ws = MockWebSocket.instances[0]!
    ws.receive({
      id: "tlr-1",
      type: "thread.list.result",
      payload: { threads: [{ id: "t1", agent_id: "w1" }] },
    })

    expect(callbacks.onThreadList).toHaveBeenCalled()
  })

  it("refcounts subscriptions", async () => {
    const client = new AgentClient(callbacks)
    client.connect("wss://test.com/ws", "w1")
    await new Promise((r) => setTimeout(r, 10))

    client.subscribe("t1")
    client.subscribe("t1")

    // Only one subscribe frame sent
    const ws = MockWebSocket.instances[0]!
    const subscribeFrames = ws.sent.filter((s) => JSON.parse(s).type === "thread.subscribe")
    expect(subscribeFrames).toHaveLength(1)

    client.unsubscribe("t1")
    // Still subscribed (refcount = 1)
    const unsubFrames = ws.sent.filter((s) => JSON.parse(s).type === "thread.unsubscribe")
    expect(unsubFrames).toHaveLength(0)

    client.unsubscribe("t1")
    // Now unsubscribed
    const unsubFrames2 = ws.sent.filter((s) => JSON.parse(s).type === "thread.unsubscribe")
    expect(unsubFrames2).toHaveLength(1)
  })

  it("disconnect cleans up", async () => {
    const client = new AgentClient(callbacks)
    client.connect("wss://test.com/ws", "w1")
    await new Promise((r) => setTimeout(r, 10))

    client.disconnect()
    const ws = MockWebSocket.instances[0]!
    expect(ws.readyState).toBe(3) // CLOSED
    expect(callbacks.setConnectionStatus).toHaveBeenCalledWith("disconnected")
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run
```

Expected: FAIL — `AgentClient` not found.

**Step 3: Implement the client**

Create `src/client.ts`:

```ts
import type { WireContentPart } from "./protocol/models"
import type { ServerToClient } from "./protocol/frames"
import type { AgentActions } from "./store"
import type { ContentPart, ThreadEvent } from "./types"
import { toThread, toThreadEvent, toRun, toWireContentPart } from "./types"

const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]

export interface AgentMetadata {
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

export type OnErrorCallback = (error: { code: string; message: string; frameType: string }) => void

export class AgentClient {
  private ws: WebSocket | null = null
  private callbacks: AgentActions
  private onError: OnErrorCallback | null = null

  private url = ""
  private agentId = ""
  private metadata: AgentMetadata = {}

  private connectFrameId = ""
  private isIntentionallyClosed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Refcounted subscriptions
  private subscriptionRefs = new Map<string, number>()

  // Track optimistic events for reconciliation
  private pendingOptimistic = new Map<string, { threadId: string; clientEventId: string }>()

  // Track last event ID per thread for gap recovery on reconnect
  private lastEventIds = new Map<string, string>()

  constructor(callbacks: AgentActions) {
    this.callbacks = callbacks
  }

  setOnError(cb: OnErrorCallback | null) {
    this.onError = cb
  }

  connect(url: string, agentId: string, metadata?: AgentMetadata) {
    this.url = url
    this.agentId = agentId
    this.metadata = metadata ?? {}
    this.isIntentionallyClosed = false
    this.callbacks.setConnectionStatus("connecting")
    this.createConnection()
  }

  disconnect() {
    this.isIntentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.callbacks.setConnectionStatus("disconnected")
  }

  retry() {
    this.reconnectAttempts = 0
    this.isIntentionallyClosed = false
    this.callbacks.setConnectionStatus("connecting")
    this.createConnection()
  }

  // --- Thread operations ---

  requestThreadList(cursor?: string | null, limit?: number) {
    this.send("thread.list", { cursor, limit })
  }

  subscribe(threadId: string) {
    const refs = this.subscriptionRefs.get(threadId) ?? 0
    this.subscriptionRefs.set(threadId, refs + 1)
    if (refs === 0) {
      const afterEventId = this.lastEventIds.get(threadId) ?? null
      this.send("thread.subscribe", { thread_id: threadId, after_event_id: afterEventId })
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

  deleteThread(threadId: string) {
    this.send("thread.delete", { thread_id: threadId })
  }

  // --- Messaging ---

  sendMessage(params: { text?: string; threadId?: string; content?: ContentPart[] }) {
    const clientEventId = crypto.randomUUID()
    const content: WireContentPart[] = params.content
      ? params.content.map(toWireContentPart)
      : [{ type: "text", text: params.text ?? "" }]

    // Build optimistic event
    const user = this.metadata.user
    const optimisticEvent: ThreadEvent = {
      id: `optimistic-${clientEventId}`,
      threadId: params.threadId ?? "",
      runId: null,
      type: "message",
      actor: "user",
      author: null,
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      content: params.content ?? [{ type: "text", text: params.text ?? "" }],
      createdAt: new Date().toISOString(),
    }

    if (params.threadId) {
      this.callbacks.addOptimistic(params.threadId, optimisticEvent, clientEventId)
    }

    this.pendingOptimistic.set(clientEventId, {
      threadId: params.threadId ?? "",
      clientEventId,
    })

    this.send("event.create", {
      thread_id: params.threadId,
      client_event_id: clientEventId,
      event: {
        type: "message" as const,
        actor: "user" as const,
        content,
      },
    })
  }

  // --- Private ---

  private createConnection() {
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
    }

    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.authenticate()
    }

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const frame = JSON.parse(e.data as string) as ServerToClient
        this.route(frame)
      } catch {
        // Ignore malformed frames
      }
    }

    this.ws.onclose = () => {
      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  private authenticate() {
    const user = this.metadata.user
    this.connectFrameId = crypto.randomUUID()
    this.sendRaw({
      id: this.connectFrameId,
      type: "connect",
      payload: {
        agent_id: this.agentId,
        organization_id: this.metadata.organizationId ?? "",
        workspace_id: this.metadata.workspaceId ?? "",
        user_id: user?.id ?? "",
        user_name: user?.name ?? "",
        user_email: user?.email ?? "",
        user_role: user?.role ?? "",
        auth_token: this.metadata.authToken,
        client: { name: "agents-server-client", version: "0.1.0" },
      },
    })
  }

  private route(frame: ServerToClient) {
    switch (frame.type) {
      case "ack": {
        if (frame.payload.ack_id === this.connectFrameId) {
          if (frame.payload.ok) {
            this.callbacks.setConnectionStatus("connected")
            this.callbacks.resetReconnect()
            this.requestThreadList()
            // Re-subscribe to previously tracked threads
            for (const threadId of this.subscriptionRefs.keys()) {
              const afterEventId = this.lastEventIds.get(threadId) ?? null
              this.send("thread.subscribe", { thread_id: threadId, after_event_id: afterEventId })
            }
          } else {
            this.callbacks.setConnectionStatus("error", frame.payload.error?.message)
          }
        } else if (!frame.payload.ok && frame.payload.error) {
          this.onError?.({
            code: frame.payload.error.code,
            message: frame.payload.error.message,
            frameType: "ack",
          })
        }
        break
      }

      case "thread.list.result":
        this.callbacks.onThreadList(frame.payload.threads.map(toThread))
        break

      case "thread.snapshot": {
        const thread = toThread(frame.payload.thread)
        const events = frame.payload.events.map(toThreadEvent)
        const runs = (frame.payload.runs ?? []).map(toRun)
        // Track last event for gap recovery
        const lastEvent = events[events.length - 1]
        if (lastEvent) {
          this.lastEventIds.set(thread.id, lastEvent.id)
        }
        this.callbacks.onThreadSnapshot(thread, events, runs)
        break
      }

      case "event.append": {
        const events = frame.payload.events.map(toThreadEvent)
        // Reconcile optimistic events
        for (const event of events) {
          for (const [clientId, pending] of this.pendingOptimistic) {
            if (pending.threadId === frame.payload.thread_id) {
              // Match by checking if it's a user message (optimistic events are user messages)
              if (event.actor === "user") {
                this.callbacks.removeOptimistic(pending.threadId, clientId)
                this.pendingOptimistic.delete(clientId)
                break
              }
            }
          }
        }
        // Track last event
        const lastEvent = events[events.length - 1]
        if (lastEvent) {
          this.lastEventIds.set(frame.payload.thread_id, lastEvent.id)
        }
        this.callbacks.onEventAppend(frame.payload.thread_id, events)
        break
      }

      case "thread.upsert":
        this.callbacks.onThreadUpsert(toThread(frame.payload.thread))
        break

      case "thread.deleted":
        this.callbacks.onThreadDeleted(frame.payload.thread_id)
        this.lastEventIds.delete(frame.payload.thread_id)
        break

      case "run.upsert":
        this.callbacks.onRunUpsert(toRun(frame.payload.run))
        break
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.setConnectionStatus("error", "Connection lost after maximum retries")
      return
    }
    this.callbacks.setConnectionStatus("disconnected")
    const delay = RECONNECT_DELAYS[this.reconnectAttempts] ?? 16000
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.callbacks.setConnectionStatus("connecting")
      this.createConnection()
    }, delay)
  }

  private send(type: string, payload: unknown) {
    this.sendRaw({ id: crypto.randomUUID(), type, payload })
  }

  private sendRaw(frame: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: add AgentClient with reconnection and refcounted subscriptions"
```

---

### Task 5: Provider and Context

**Files:**
- Create: `src/provider.tsx`

**Step 1: Implement the provider**

Create `src/provider.tsx`:

```tsx
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import { useStore as useZustandStore } from "zustand"
import { AgentClient, type AgentMetadata, type OnErrorCallback } from "./client"
import { createAgentStore, type AgentState, type AgentStore } from "./store"

interface AgentContextValue {
  store: AgentStore
  client: AgentClient
}

const AgentContext = createContext<AgentContextValue | null>(null)

export interface AgentProviderProps {
  url: string
  agentId: string
  metadata?: AgentMetadata
  onError?: OnErrorCallback
  children: ReactNode
}

export function AgentProvider({ url, agentId, metadata, onError, children }: AgentProviderProps) {
  const storeRef = useRef<AgentStore | undefined>(undefined)
  const clientRef = useRef<AgentClient | undefined>(undefined)

  if (!storeRef.current) {
    storeRef.current = createAgentStore()
    clientRef.current = new AgentClient(storeRef.current.getState().actions)
  }

  // Update onError callback
  useEffect(() => {
    clientRef.current?.setOnError(onError ?? null)
  }, [onError])

  // Connect/disconnect lifecycle
  useEffect(() => {
    clientRef.current?.connect(url, agentId, metadata)
    return () => clientRef.current?.disconnect()
  }, [url, agentId, metadata])

  return (
    <AgentContext.Provider value={{ store: storeRef.current, client: clientRef.current! }}>
      {children}
    </AgentContext.Provider>
  )
}

// Internal hook for other hooks to access context
export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) {
    throw new Error("useAgentContext must be used within a <AgentProvider>")
  }
  return ctx
}

// Re-export useStore for hooks to use with our store type
export function useStore<T>(selector: (state: AgentState) => T): T {
  const { store } = useAgentContext()
  return useZustandStore(store, selector)
}
```

**Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/provider.tsx
git commit -m "feat: add AgentProvider and context"
```

---

### Task 6: Hooks

**Files:**
- Create: `src/hooks/use-connection.ts`
- Create: `src/hooks/use-threads.ts`
- Create: `src/hooks/use-thread.ts`
- Create: `src/hooks/use-message.ts`

**Step 1: Implement useConnection**

Create `src/hooks/use-connection.ts`:

```ts
import { useCallback } from "react"
import { useAgentContext, useStore } from "../provider"

export function useConnection() {
  const { client } = useAgentContext()

  const status = useStore((s) => s.connection.status)
  const error = useStore((s) => s.connection.error)
  const reconnectFailed = useStore((s) => s.connection.reconnectFailed)

  const reconnect = useCallback(() => client.retry(), [client])

  return { status, error, reconnectFailed, reconnect }
}
```

**Step 2: Implement useThreads**

Create `src/hooks/use-threads.ts`:

```ts
import { useCallback } from "react"
import { useAgentContext, useStore } from "../provider"

export function useThreads() {
  const { client } = useAgentContext()

  const threads = useStore((s) => s.threadOrder.map((id) => s.threads[id]!).filter(Boolean))
  const isLoading = useStore((s) => s.connection.status !== "connected")

  const deleteThread = useCallback((threadId: string) => client.deleteThread(threadId), [client])

  return { threads, isLoading, deleteThread }
}
```

**Step 3: Implement useThread**

Create `src/hooks/use-thread.ts`:

```ts
import { useEffect } from "react"
import { useAgentContext, useStore } from "../provider"
import type { ThreadState } from "../types"

const EMPTY_THREAD_STATE: ThreadState = {
  thread: null,
  events: [],
  runs: [],
  isLoading: false,
}

export function useThread<T = ThreadState>(
  threadId: string | null,
  options?: { select?: (state: ThreadState) => T },
): T {
  const { client } = useAgentContext()

  // Auto-subscribe/unsubscribe
  useEffect(() => {
    if (!threadId) return
    client.subscribe(threadId)
    return () => client.unsubscribe(threadId)
  }, [threadId, client])

  const select = options?.select ?? ((s: ThreadState) => s as T)

  return useStore((s) => {
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

**Step 4: Implement useMessage**

Create `src/hooks/use-message.ts`:

```ts
import { useCallback } from "react"
import { useAgentContext, useStore } from "../provider"
import type { ContentPart } from "../types"

export function useMessage() {
  const { client } = useAgentContext()

  const isWaiting = useStore((s) => {
    for (const threadId of s.subscriptions) {
      const runs = s.runs[threadId] ?? []
      if (runs.some((r) => r.status === "running")) return true
    }
    return false
  })

  const send = useCallback(
    (params: { text?: string; threadId?: string; content?: ContentPart[] }) => {
      client.sendMessage(params)
    },
    [client],
  )

  return { send, isWaiting }
}
```

**Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/hooks/
git commit -m "feat: add useConnection, useThreads, useThread, useMessage hooks"
```

---

### Task 7: Public Exports and Build

**Files:**
- Modify: `src/main.ts`

**Step 1: Wire up main.ts**

Replace `src/main.ts`:

```ts
// Components
export { AgentProvider } from "./provider"
export type { AgentProviderProps } from "./provider"

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
  Actor,
  EventType,
} from "./types"

// Client types (for advanced usage)
export type { AgentMetadata } from "./client"
```

**Step 2: Build**

```bash
npx tsup
```

Expected: Clean build with ESM + CJS + DTS output in `dist/`.

**Step 3: Run all tests**

```bash
npx vitest run
```

Expected: All PASS.

**Step 4: Run linter**

```bash
npx biome check .
```

Fix any issues.

**Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire public exports and verify build"
```

---

### Task 8: Final Verification

**Step 1: Run full check suite**

```bash
npx tsc --noEmit && npx vitest run && npx tsup && npx biome check .
```

All must pass.

**Step 2: Verify dist output**

```bash
ls dist/
```

Expected: `main.js`, `main.cjs`, `main.d.ts`, `main.d.cts` (plus sourcemaps).

**Step 3: Verify exports are correct**

```bash
node -e "const m = require('./dist/main.cjs'); console.log(Object.keys(m))"
```

Expected: `AgentProvider`, `useConnection`, `useThreads`, `useThread`, `useMessage`.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: final verification and cleanup"
```
