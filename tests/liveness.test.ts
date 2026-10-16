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

async function openAndAck(autoPong = false) {
  await vi.advanceTimersByTimeAsync(1);
  const ws = last();
  ws.autoPong = autoPong;
  ackConnect(ws, true);
  return ws;
}

describe("AgentClient liveness and resume", () => {
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

  it("reconnects when no frame arrives for 90s", async () => {
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    const first = await openAndAck();

    await vi.advanceTimersByTimeAsync(121_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(first.closedWith).not.toBeNull();
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("pongs keep the socket alive", async () => {
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    await openAndAck(true);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("visible again after giving up reconnects at once", async () => {
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1);
      last().drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(callbacks.setReconnectFailed).toHaveBeenCalled();
    const before = MockWebSocket.instances.length;
    vi.mocked(callbacks.resetReconnect).mockClear();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);

    expect(MockWebSocket.instances.length).toBe(before + 1);
    expect(callbacks.resetReconnect).toHaveBeenCalled();
  });

  it("online while waiting to reconnect skips the backoff", async () => {
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    await vi.advanceTimersByTimeAsync(1);
    last().drop(); // failure 1, wait ~1s
    await vi.advanceTimersByTimeAsync(1_500);
    last().drop(); // failure 2, wait ~2s
    await vi.advanceTimersByTimeAsync(2_500);
    last().drop(); // failure 3, wait ~4s... pending
    const before = MockWebSocket.instances.length;

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10);

    expect(MockWebSocket.instances.length).toBe(before + 1);
  });

  it("disconnect removes the resume listeners", async () => {
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    await openAndAck();
    client.disconnect();
    const before = MockWebSocket.instances.length;

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10);

    expect(MockWebSocket.instances).toHaveLength(before);
  });
});
