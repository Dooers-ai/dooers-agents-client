import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "../src/client";
import { canEditMemory } from "../src/types";
import { createAgentStore } from "../src/store";
import { MockWebSocket, ackConnect } from "./helpers/mock-websocket";

async function connectTo(version: string) {
  const store = createAgentStore();
  const client = new AgentClient(store.getState().actions);
  client.setMemoryCursorReader(() => store.getState().memory.cursor);
  client.connect("wss://test.com/ws", "w1");
  await new Promise((r) => setTimeout(r, 10));
  const ws = MockWebSocket.instances[0] as MockWebSocket;
  ackConnect(ws, true, undefined, { name: "dooers-agents-server", version });
  return { client, store, ws };
}

function sentOfType(ws: MockWebSocket, type: string) {
  return ws.sent.map((s) => JSON.parse(s)).filter((f) => f.type === type);
}

function ack(ws: MockWebSocket, frameId: string, ok = true, error?: { code: string; message: string }) {
  ws.receive({ id: `a-${frameId}`, type: "ack", payload: { ack_id: frameId, ok, ...(error ? { error } : {}) } });
}

const thread = {
  id: "t1",
  agent_id: "w1",
  organization_id: "",
  workspace_id: "",
  owner: { user_id: "u1" },
  users: [],
  title: null,
  created_at: "2026-10-31T10:00:00Z",
  updated_at: "2026-10-31T10:00:00Z",
  last_event_at: "2026-10-31T10:00:00Z",
};

function draft(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "e1",
    thread_id: "t1",
    run_id: "r1",
    type: "message",
    actor: "assistant",
    author: "Bot",
    content: [{ type: "text", text }],
    created_at: "2026-10-31T10:00:01Z",
    ...extra,
  };
}

describe("frontier features", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams deltas into the draft event, drops replays and ends with the final event", async () => {
    const { store, ws } = await connectTo("0.26.0");
    ws.receive({ id: "s", type: "thread.snapshot", payload: { thread, events: [], runs: [] } });
    ws.receive({ id: "a", type: "event.append", payload: { thread_id: "t1", events: [draft("Olá", { streaming: true })] } });
    ws.receive({ id: "d1", type: "event.delta", payload: { thread_id: "t1", event_id: "e1", kind: "text", delta: ", mun", seq: 1 } });
    ws.receive({ id: "d1b", type: "event.delta", payload: { thread_id: "t1", event_id: "e1", kind: "text", delta: ", mun", seq: 1 } });
    ws.receive({ id: "d2", type: "event.delta", payload: { thread_id: "t1", event_id: "e1", kind: "text", delta: "do", seq: 2 } });

    let event = store.getState().events.t1?.[0];
    expect(event?.streaming).toBe(true);
    expect(event?.content?.[0]).toEqual({ type: "text", text: "Olá, mundo" });

    ws.receive({ id: "f", type: "event.append", payload: { thread_id: "t1", events: [draft("Olá, mundo!", { finalized: true })] } });
    event = store.getState().events.t1?.[0];
    expect(event?.streaming).toBeUndefined();
    expect(event?.content?.[0]).toEqual({ type: "text", text: "Olá, mundo!" });
    expect(store.getState().events.t1).toHaveLength(1);
  });

  it("appends reasoning deltas to data.text and ignores unknown events", async () => {
    const { store, ws } = await connectTo("0.26.0");
    ws.receive({ id: "s", type: "thread.snapshot", payload: { thread, events: [], runs: [] } });
    ws.receive({
      id: "a",
      type: "event.append",
      payload: { thread_id: "t1", events: [{ ...draft(""), type: "reasoning", content: undefined, data: { text: "Pens" }, streaming: true }] },
    });
    ws.receive({ id: "d", type: "event.delta", payload: { thread_id: "t1", event_id: "e1", kind: "reasoning", delta: "ando", seq: 1 } });
    ws.receive({ id: "x", type: "event.delta", payload: { thread_id: "t1", event_id: "nope", kind: "text", delta: "?", seq: 1 } });
    expect(store.getState().events.t1?.[0]?.data?.text).toBe("Pensando");
    expect(store.getState().events.t1).toHaveLength(1);
  });

  it("only sends run.cancel to servers that support it and settles on the ack", async () => {
    const old = await connectTo("0.25.0");
    await expect(old.client.cancelRun("t1")).rejects.toThrow(/0.26.0/);
    expect(sentOfType(old.ws, "run.cancel")).toHaveLength(0);

    MockWebSocket.instances = [];
    const { client, ws } = await connectTo("0.26.0");
    const done = client.cancelRun("t1", "r1");
    const frame = sentOfType(ws, "run.cancel")[0];
    expect(frame.payload).toEqual({ thread_id: "t1", run_id: "r1" });
    ack(ws, frame.id);
    await expect(done).resolves.toBeUndefined();

    const refused = client.cancelRun("t1");
    ack(ws, sentOfType(ws, "run.cancel")[1].id, false, { code: "RUN_NOT_FOUND", message: "No active run" });
    await expect(refused).rejects.toThrow("No active run");
  });

  it("keeps the memory list in sync with list results, upserts and deletions", async () => {
    const { client, store, ws } = await connectTo("0.26.0");
    expect(client.requestMemories({ query: "café" })).toBe(true);
    expect(sentOfType(ws, "memory.list")[0].payload).toMatchObject({ query: "café", cursor: null });
    expect(store.getState().memory.isLoading).toBe(true);
    const record = (id: string, content: string, pinned = false) => ({
      id,
      agent_id: "w1",
      organization_id: "o",
      workspace_id: "",
      user_id: "u1",
      scope: "user",
      kind: "fact",
      content,
      tags: [],
      pinned,
      use_count: 0,
      created_at: "2026-10-31T10:00:00Z",
      updated_at: "2026-10-31T10:00:00Z",
    });
    ws.receive({
      id: "l",
      type: "memory.list.result",
      payload: { memories: [record("m1", "Gosta de café")], cursor: "1", has_more: true, available: true, can_manage_workspace: false },
    });
    expect(store.getState().memory).toMatchObject({ loaded: true, isLoading: false, hasMore: true, cursor: "1", available: true });

    client.requestMemories({ append: true });
    expect(sentOfType(ws, "memory.list")[1].payload.cursor).toBe("1");
    ws.receive({
      id: "l2",
      type: "memory.list.result",
      payload: { memories: [record("m2", "Mora em Curitiba")], cursor: null, has_more: false, available: true, can_manage_workspace: false },
    });
    expect(store.getState().memory.items.map((m) => m.id)).toEqual(["m1", "m2"]);

    ws.receive({ id: "u", type: "memory.upsert", payload: { memory: { ...record("m3", "Fixada", true), updated_at: "2026-10-31T11:00:00Z" } } });
    expect(store.getState().memory.items[0]?.id).toBe("m3");
    ws.receive({ id: "x", type: "memory.deleted", payload: { memory_id: "m1" } });
    expect(store.getState().memory.items.map((m) => m.id)).toEqual(["m3", "m2"]);

    ws.receive({
      id: "p",
      type: "memory.prefs",
      payload: { prefs: { agent_id: "w1", organization_id: "o", user_id: "u1", enabled: true, custom_instructions: "Seja breve", about_me: "" }, available: true },
    });
    expect(store.getState().memory.prefs?.customInstructions).toBe("Seja breve");

    const saved = client.updateMemoryPrefs({ customInstructions: "Use tópicos" });
    const prefsFrame = sentOfType(ws, "memory.prefs.update")[0];
    expect(prefsFrame.payload).toEqual({ custom_instructions: "Use tópicos" });
    ack(ws, prefsFrame.id);
    await saved;
  });

  it("separates personal and workspace memory: author, editing rights and sharing", async () => {
    const { client, store, ws } = await connectTo("0.26.0");
    client.updateConnectionConfig({ userId: "ana" });
    const base = {
      agent_id: "w1",
      organization_id: "o",
      workspace_id: "ws",
      kind: "fact",
      tags: [],
      pinned: false,
      use_count: 0,
      created_at: "2026-10-31T10:00:00Z",
      updated_at: "2026-10-31T10:00:00Z",
    };
    ws.receive({
      id: "l",
      type: "memory.list.result",
      payload: {
        memories: [
          { ...base, id: "m1", user_id: "ana", scope: "user", content: "Pessoal", author_id: "ana", author_name: "Ana" },
          { ...base, id: "m2", user_id: "", scope: "workspace", content: "Da Ana", author_id: "ana", author_name: "Ana" },
          { ...base, id: "m3", user_id: "", scope: "workspace", content: "Do Bruno", author_id: "bruno", author_name: "Bruno" },
        ],
        cursor: null,
        has_more: false,
        available: true,
        can_manage_workspace: false,
      },
    });
    const items = store.getState().memory.items;
    expect(items.find((m) => m.id === "m2")?.authorName).toBe("Ana");
    const viewer = { userId: client.currentUserId(), canManageWorkspace: false };
    const editable = Object.fromEntries(items.map((m) => [m.id, canEditMemory(m, viewer)]));
    expect(editable).toEqual({ m1: true, m2: true, m3: false });
    expect(canEditMemory(items.find((m) => m.id === "m3")!, { ...viewer, canManageWorkspace: true })).toBe(true);

    const shared = client.shareMemory("m1");
    const frame = sentOfType(ws, "memory.update")[0];
    expect(frame.payload).toEqual({ memory_id: "m1", scope: "workspace" });
    ack(ws, frame.id);
    await shared;
  });

  it("tracks schedules and drops canceled ones", async () => {
    const { client, store, ws } = await connectTo("0.26.0");
    client.requestSchedules();
    const schedule = (id: string, status: string, next: string) => ({
      id,
      agent_id: "w1",
      organization_id: "o",
      workspace_id: "",
      user_id: "u1",
      title: id,
      instruction: "x",
      kind: "reminder",
      recurrence: { freq: "daily", interval: 1, at_time: "09:00" },
      timezone: "America/Sao_Paulo",
      next_run_at: next,
      status,
      run_count: 0,
      created_at: "2026-10-31T10:00:00Z",
      updated_at: "2026-10-31T10:00:00Z",
    });
    ws.receive({
      id: "s",
      type: "schedule.list.result",
      payload: { schedules: [schedule("b", "active", "2026-11-02T12:00:00Z"), schedule("a", "active", "2026-11-01T12:00:00Z")], available: true },
    });
    expect(store.getState().schedules.items.map((s) => s.id)).toEqual(["a", "b"]);
    expect(store.getState().schedules.items[0]?.recurrence.atTime).toBe("09:00");
    ws.receive({ id: "u", type: "schedule.upsert", payload: { schedule: schedule("a", "paused", "2026-11-01T12:00:00Z") } });
    expect(store.getState().schedules.items.find((s) => s.id === "a")?.status).toBe("paused");
    ws.receive({ id: "d", type: "schedule.deleted", payload: { schedule_id: "b" } });
    expect(store.getState().schedules.items.map((s) => s.id)).toEqual(["a"]);
  });

  it("sends the browser time zone and locale only to servers that read them", async () => {
    const old = await connectTo("0.25.0");
    void old.client.sendMessage({ text: "oi", threadId: "t1" }).catch(() => {});
    expect(sentOfType(old.ws, "event.create")[0].payload.chat_context).toBeUndefined();

    MockWebSocket.instances = [];
    const { client, ws } = await connectTo("0.26.0");
    void client.sendMessage({ text: "oi", threadId: "t1", chatContext: { llmModel: "m" } }).catch(() => {});
    const context = sentOfType(ws, "event.create")[0].payload.chat_context;
    expect(context.llm_model).toBe("m");
    expect(typeof context.timezone).toBe("string");
    expect(context.timezone.length).toBeGreaterThan(0);
  });
});
