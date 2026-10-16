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

function last(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1] as MockWebSocket;
}

async function openAndAck(ok: boolean, error?: { code: string; message: string }) {
  await vi.advanceTimersByTimeAsync(1);
  const ws = last();
  ackConnect(ws, ok, error);
  return ws;
}

describe("AgentClient reconnect", () => {
  let callbacks: AgentActions;

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = createMockCallbacks();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps reconnecting after many drops that each followed a successful connect", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });

    // Cloud Run cuts every socket at 300s. Each cut is followed by a good reconnect.
    for (let cut = 0; cut < 8; cut++) {
      const ws = await openAndAck(true);
      ws.drop();
      await vi.advanceTimersByTimeAsync(1_500);
    }

    expect(callbacks.setReconnectFailed).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(9);
  });

  it("reports a rejected connect through onError", async () => {
    const client = new AgentClient(callbacks);
    const onError = vi.fn();
    client.setOnError(onError);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "expired" });

    await openAndAck(false, { code: "CONNECTION_REJECTED", message: "invalid_token" });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CONNECTION_REJECTED", message: "invalid_token" })
    );
  });

  it("retries a rejected connect with the refreshed token", async () => {
    const client = new AgentClient(callbacks);
    const getAuthToken = vi.fn().mockResolvedValueOnce("expired").mockResolvedValueOnce("fresh");
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", getAuthToken });

    await openAndAck(false, { code: "CONNECTION_REJECTED", message: "invalid_token" });
    await vi.advanceTimersByTimeAsync(3_000);

    const tokens = MockWebSocket.instances.map((ws) => ws.connectFrame()?.payload.auth_token);
    expect(tokens).toEqual(["expired", "fresh"]);
  });

  it("calls getAuthToken before every socket", async () => {
    const client = new AgentClient(callbacks);
    const getAuthToken = vi.fn().mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", getAuthToken });

    const ws = await openAndAck(true);
    ws.drop();
    await vi.advanceTimersByTimeAsync(1_500);

    const tokens = MockWebSocket.instances.map((w) => w.connectFrame()?.payload.auth_token);
    expect(tokens).toEqual(["t1", "t2"]);
  });

  it("a throwing getAuthToken counts as a failed attempt", async () => {
    const client = new AgentClient(callbacks);
    const getAuthToken = vi.fn().mockRejectedValue(new Error("boom"));
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", getAuthToken });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(callbacks.setReconnectFailed).toHaveBeenCalled();
    expect(callbacks.setConnectionStatus).toHaveBeenLastCalledWith("error", "auth token unavailable");
  });

  it("drops an attempt that went stale while the token was loading", async () => {
    const client = new AgentClient(callbacks);
    let resolveToken: (t: string) => void = () => {};
    const getAuthToken = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveToken = resolve;
      })
    );
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", getAuthToken });
    client.disconnect();
    resolveToken("late");
    await vi.advanceTimersByTimeAsync(10);

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("counts one failure per rejected attempt", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "expired" });

    const ws = await openAndAck(false, { code: "CONNECTION_REJECTED", message: "invalid_token" });
    ws.drop();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("upload sends the fresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ref_id: "r", mime_type: "text/plain", filename: "a.txt", size_bytes: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentClient(callbacks);
    client.setUploadUrl("https://test.com/uploads");
    client.connect("wss://test.com/ws", "agent-1", {
      userId: "u1",
      getAuthToken: () => "fresh",
    });

    await client.upload(new File(["x"], "a.txt"));

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh");
  });

  it("gives up after five consecutive failed attempts", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });

    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(1);
      last().drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    const count = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(callbacks.setReconnectFailed).toHaveBeenCalledTimes(1);
    expect(callbacks.setConnectionStatus).toHaveBeenLastCalledWith("error", "connection closed");
    expect(MockWebSocket.instances).toHaveLength(count);
  });

  it("retry while a reconnect is pending opens one socket", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    const ws = await openAndAck(true);
    ws.drop();

    client.retry();
    client.retry();
    client.retry();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(MockWebSocket.instances).toHaveLength(2);
  });
  it("retry after disconnect mid-attempt opens a socket", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    await vi.advanceTimersByTimeAsync(1);
    client.disconnect();

    client.retry();
    await vi.advanceTimersByTimeAsync(1);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(last().connectFrame().type).toBe("connect");
  });
});
