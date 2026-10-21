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

function sentTypes(ws: MockWebSocket): string[] {
  return ws.sent.map((s) => JSON.parse(s).type);
}

/** Servers before agents-server 0.10.3 do not know `ping` and close the socket on it. */
function closeOnPing(ws: MockWebSocket) {
  const send = ws.send.bind(ws);
  ws.send = (data: string) => {
    send(data);
    if (JSON.parse(data).type === "ping") ws.drop();
  };
}

describe("AgentClient with a server that does not announce its version", () => {
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

  it("does not ping it and does not judge it dead", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    await vi.advanceTimersByTimeAsync(1);
    ackConnect(last(), true, undefined, null);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(sentTypes(last())).not.toContain("ping");
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(last().closedWith).toBeNull();
  });

  it("stays connected to a server that closes the socket on ping", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    await vi.advanceTimersByTimeAsync(1);
    closeOnPing(last());
    ackConnect(last(), true, undefined, null);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(callbacks.setConnectionStatus).not.toHaveBeenCalledWith("disconnected");
  });

  it("still pings a server that announced its version", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "agent-1", { userId: "u1", authToken: "t" });
    await vi.advanceTimersByTimeAsync(1);
    ackConnect(last(), true);

    await vi.advanceTimersByTimeAsync(31_000);

    expect(sentTypes(last())).toContain("ping");
  });
});
