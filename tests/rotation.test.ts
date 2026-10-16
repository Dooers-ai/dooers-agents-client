import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "../src/client";
import type { AgentActions } from "../src/store";
import { MockWebSocket, ackConnect } from "./helpers/mock-websocket";

function createMockCallbacks(): AgentActions {
  return new Proxy({} as AgentActions, {
    get(target, prop: string) {
      if (!(prop in target)) {
        (target as Record<string, unknown>)[prop] = vi.fn();
      }
      return (target as Record<string, unknown>)[prop];
    },
  });
}

function socket(index: number): MockWebSocket {
  return MockWebSocket.instances[index] as MockWebSocket;
}

function sentFrames(ws: MockWebSocket): { type: string; payload: Record<string, unknown> }[] {
  return ws.sent.map((s) => JSON.parse(s));
}

function runUpsert(status: "running" | "succeeded") {
  return {
    id: "s-run",
    type: "run.upsert",
    payload: {
      run: {
        id: "r-1",
        thread_id: "t-1",
        agent_id: "agent-1",
        status,
        started_at: "2026-10-16T00:00:00Z",
        ended_at: null,
        error: null,
      },
    },
  };
}

function eventAppend(threadId: string, eventId: string) {
  return {
    id: "s-evt",
    type: "event.append",
    payload: {
      thread_id: threadId,
      events: [
        {
          id: eventId,
          thread_id: threadId,
          run_id: null,
          type: "message",
          actor: "assistant",
          author: null,
          metadata: {},
          content: [{ type: "text", text: "hello" }],
          created_at: "2026-10-16T00:00:00Z",
        },
      ],
    },
  };
}

describe("AgentClient planned renewal", () => {
  let callbacks: AgentActions;
  let client: AgentClient;

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = createMockCallbacks();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    client = new AgentClient(callbacks);
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  async function connectPrimary(): Promise<MockWebSocket> {
    let n = 0;
    const getAuthToken = vi.fn(async () => `t${++n}`);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", getAuthToken });
    await vi.advanceTimersByTimeAsync(1);
    const first = socket(0);
    first.autoPong = true;
    ackConnect(first, true);
    return first;
  }

  it("rotates an idle connection after 30 minutes without status change", async () => {
    const first = await connectPrimary();
    client.subscribe("t-1");
    client.subscribeSettings({ audience: "user" });
    first.receive(eventAppend("t-1", "e-9"));

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 31_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = socket(1);
    second.autoPong = true;
    expect(second.connectFrame().payload.auth_token).toBe("t2");
    ackConnect(second, true);

    expect(first.closedWith).toBe(1000);
    const sent = sentFrames(second);
    expect(sent.some((f) => f.type === "thread.list")).toBe(true);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "thread.subscribe",
        payload: expect.objectContaining({ thread_id: "t-1", after_event_id: "e-9" }),
      })
    );
    expect(sent.some((f) => f.type === "settings.subscribe")).toBe(true);
    const statuses = vi.mocked(callbacks.setConnectionStatus).mock.calls.map((c) => c[0]);
    const afterConnected = statuses.slice(statuses.indexOf("connected") + 1);
    expect(afterConnected).not.toContain("disconnected");
    expect(afterConnected).not.toContain("connecting");

    // Late frames on the old socket are ignored.
    first.receive(runUpsert("running"));
    expect(callbacks.onRunUpsert).not.toHaveBeenCalled();

    // The promoted socket is the primary now: it stays up and nothing reconnects.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(second.closedWith).toBeNull();
  });

  it("waits for an active run before rotating", async () => {
    const first = await connectPrimary();
    first.receive(runUpsert("running"));

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    first.receive(runUpsert("succeeded"));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("rotates at 55 minutes even while busy", async () => {
    const first = await connectPrimary();
    first.receive(runUpsert("running"));

    await vi.advanceTimersByTimeAsync(54 * 60_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000 + 31_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("rotation does not abort pending sends", async () => {
    const first = await connectPrimary();
    first.receive(runUpsert("running"));

    await vi.advanceTimersByTimeAsync(55 * 60_000 + 1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = socket(1);
    second.autoPong = true;

    let rejected: unknown = null;
    client.sendMessage({ threadId: "t-1", text: "hi" }).catch((err) => {
      rejected = err;
    });
    expect(sentFrames(first).some((f) => f.type === "event.create")).toBe(true);
    ackConnect(second, true);
    await vi.advanceTimersByTimeAsync(100);

    expect(first.closedWith).toBe(1000);
    expect(rejected).toBeNull();
  });

  it("a rejected candidate keeps the current socket", async () => {
    const first = await connectPrimary();

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    const candidate = socket(1);
    ackConnect(candidate, false, { code: "CONNECTION_REJECTED", message: "invalid_token" });

    expect(candidate.closedWith).not.toBeNull();
    expect(first.closedWith).toBeNull();

    await vi.advanceTimersByTimeAsync(31_000);
    expect(first.closedWith).toBeNull();
    expect(callbacks.setReconnectFailed).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("primary drop during rotation discards the candidate", async () => {
    const first = await connectPrimary();

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    const candidate = socket(1);
    first.drop();

    expect(candidate.closedWith !== null || candidate.onmessage === null).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockWebSocket.instances).toHaveLength(3);
    const active = MockWebSocket.instances.filter((ws) => ws.closedWith === null);
    expect(active).toEqual([socket(2)]);
  });

  it("opens one candidate when a slow token lets two rotations start", async () => {
    const resolvers: ((token: string) => void)[] = [];
    let calls = 0;
    const getAuthToken = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve("t1");
      return new Promise<string>((resolve) => resolvers.push(resolve));
    });
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", getAuthToken });
    await vi.advanceTimersByTimeAsync(1);
    socket(0).autoPong = true;
    ackConnect(socket(0), true);

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 31_000);
    expect(resolvers).toHaveLength(2);
    for (const resolve of resolvers) resolve("slow");
    await vi.advanceTimersByTimeAsync(10);

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("disconnect during rotation closes the candidate", async () => {
    await connectPrimary();

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    const candidate = socket(1);
    client.disconnect();

    expect(candidate.closedWith).not.toBeNull();
    ackConnect(candidate, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("renewal keeps the thread list queue filter", async () => {
    await connectPrimary();
    client.requestThreadList(undefined, undefined, "sales");

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    const second = socket(1);
    ackConnect(second, true);

    const list = sentFrames(second).find((f) => f.type === "thread.list");
    expect(list?.payload.queue).toBe("sales");
  });

  it("a page request lost with the old socket does not block the next one", async () => {
    const first = await connectPrimary();
    first.receive({
      id: "s-list",
      type: "thread.list.result",
      payload: { threads: [], cursor: "c1", total_count: 0 },
    });
    client.loadMoreThreads();

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    const second = socket(1);
    ackConnect(second, true);
    client.loadMoreThreads();

    const pages = sentFrames(second).filter((f) => f.type === "thread.list" && f.payload.cursor);
    expect(pages).toHaveLength(1);
  });

  it("renewal restores the analytics subscription", async () => {
    await connectPrimary();
    client.subscribeAnalytics();

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    const second = socket(1);
    ackConnect(second, true);

    expect(sentFrames(second).some((f) => f.type === "analytics.subscribe")).toBe(true);
  });
});
