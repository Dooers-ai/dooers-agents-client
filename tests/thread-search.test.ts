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

async function connectTo(version: string) {
  const callbacks = createMockCallbacks();
  const client = new AgentClient(callbacks);
  client.connect("wss://test.com/ws", "w1");
  await new Promise((r) => setTimeout(r, 10));
  const ws = MockWebSocket.instances[0] as MockWebSocket;
  ackConnect(ws, true, undefined, { name: "dooers-agents-server", version });
  return { client, callbacks, ws };
}

function sentOfType(ws: MockWebSocket, type: string) {
  return ws.sent.map((s) => JSON.parse(s)).filter((f) => f.type === type);
}

describe("thread search", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never sends thread.search to a server older than 0.25.0", async () => {
    const { client, ws } = await connectTo("0.24.5");

    expect(client.searchThreads("pedido")).toBe(false);

    expect(sentOfType(ws, "thread.search")).toHaveLength(0);
  });

  it("drops the answer to a search the user already replaced", async () => {
    const { client, callbacks, ws } = await connectTo("0.25.0");

    client.searchThreads("ped");
    client.searchThreads("pedido");
    expect(sentOfType(ws, "thread.search").map((f) => f.payload.query)).toEqual(["ped"]);

    ws.receive({
      id: "r1",
      type: "thread.search.result",
      payload: { query: "ped", threads: [], cursor: null, total_count: 3 },
    });
    expect(callbacks.onThreadSearchResult).not.toHaveBeenCalled();
    expect(sentOfType(ws, "thread.search").map((f) => f.payload.query)).toEqual(["ped", "pedido"]);

    ws.receive({
      id: "r2",
      type: "thread.search.result",
      payload: { query: "pedido", threads: [], cursor: null, total_count: 1 },
    });
    expect(callbacks.onThreadSearchResult).toHaveBeenCalledWith("pedido", [], null, 1, false);
  });

  it("ends a search the server refused with no results instead of loading forever", async () => {
    const { client, callbacks, ws } = await connectTo("0.25.0");

    client.searchThreads("pedido");
    const sent = sentOfType(ws, "thread.search")[0];
    ws.receive({
      id: "a1",
      type: "ack",
      payload: { ack_id: sent.id, ok: false, error: { code: "SEARCH_FAILED", message: "x" } },
    });

    expect(callbacks.onThreadSearchResult).toHaveBeenCalledWith("pedido", [], null, 0, false);
    expect(callbacks.clearThreadSearch).not.toHaveBeenCalled();
  });
});
