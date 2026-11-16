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

type Frame = { type: string; payload: Record<string, unknown> };

function eventCreates(ws: MockWebSocket): Frame[] {
  return ws.sent.map((s) => JSON.parse(s) as Frame).filter((f) => f.type === "event.create");
}

describe("presence_token on event.create", () => {
  let client: AgentClient;
  let ws: MockWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    client = new AgentClient(createMockCallbacks());
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  async function connect(opts: Parameters<AgentClient["connect"]>[2]) {
    client.connect("wss://test.com/ws", "agent-1", opts);
    await vi.advanceTimersByTimeAsync(1);
    ws = MockWebSocket.instances[0] as MockWebSocket;
    ws.autoPong = true;
    ackConnect(ws, true);
  }

  const send = (text: string) => {
    const p = client.sendMessage({ threadId: "t-1", text });
    p.catch(() => {});
    return p;
  };

  it("sends the connect token synchronously while it is fresh, then a new one after 60s", async () => {
    let n = 0;
    const getAuthToken = vi.fn(async () => `t${++n}`);
    await connect({ userId: "u1", getAuthToken });
    expect(getAuthToken).toHaveBeenCalledTimes(1);

    send("one");
    // synchronous: the frame is already out, no timer or microtask needed
    expect(eventCreates(ws)).toHaveLength(1);
    expect(eventCreates(ws)[0]?.payload.presence_token).toBe("t1");
    expect((eventCreates(ws)[0]?.payload.metadata as Record<string, unknown>)?.presence_token).toBeUndefined();

    await vi.advanceTimersByTimeAsync(61_000);
    send("two");
    await vi.advanceTimersByTimeAsync(1);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(eventCreates(ws)[1]?.payload.presence_token).toBe("t2");
  });

  it("reuses the token within 60s", async () => {
    const getAuthToken = vi.fn(async () => "tok");
    await connect({ userId: "u1", getAuthToken });
    send("one");
    await vi.advanceTimersByTimeAsync(10_000);
    send("two");
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(eventCreates(ws).map((f) => f.payload.presence_token)).toEqual(["tok", "tok"]);
  });

  it("keeps order and shares one fetch when the token is stale and slow", async () => {
    const pending: ((t: string) => void)[] = [];
    let calls = 0;
    const getAuthToken = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve("t1");
      return new Promise<string>((r) => pending.push(r));
    });
    await connect({ userId: "u1", getAuthToken });
    await vi.advanceTimersByTimeAsync(61_000);

    send("first");
    send("second");
    await vi.advanceTimersByTimeAsync(1);
    expect(eventCreates(ws)).toHaveLength(0);
    expect(pending).toHaveLength(1);

    pending[0]?.("t2");
    await vi.advanceTimersByTimeAsync(1);
    const frames = eventCreates(ws);
    expect(frames.map((f) => f.payload.presence_token)).toEqual(["t2", "t2"]);
    const texts = frames.map((f) => ((f.payload.event as { content: { text: string }[] }).content[0] as { text: string }).text);
    expect(texts).toEqual(["first", "second"]);
  });

  it("failing getAuthToken: the message goes out without presence_token", async () => {
    let calls = 0;
    const getAuthToken = vi.fn(async () => {
      if (++calls === 1) return "t1";
      throw new Error("boom");
    });
    await connect({ userId: "u1", getAuthToken });
    await vi.advanceTimersByTimeAsync(61_000);
    send("hi");
    await vi.advanceTimersByTimeAsync(1);
    const [frame] = eventCreates(ws);
    expect(frame).toBeDefined();
    expect("presence_token" in (frame as Frame).payload).toBe(false);
  });

  it("slow getAuthToken: the message goes out without presence_token within 15s and the queue moves", async () => {
    let calls = 0;
    const getAuthToken = vi.fn(() => {
      if (++calls === 1) return Promise.resolve("t1");
      return new Promise<string>(() => {});
    });
    await connect({ userId: "u1", getAuthToken });
    await vi.advanceTimersByTimeAsync(61_000);
    send("hi");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(eventCreates(ws)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(eventCreates(ws)).toHaveLength(1);
    expect("presence_token" in (eventCreates(ws)[0] as Frame).payload).toBe(false);
  });

  it("form responses carry presence_token too", async () => {
    await connect({ userId: "u1", getAuthToken: async () => "tok" });
    client.sendFormResponse({ threadId: "t-1", formEventId: "f1", cancelled: false, values: {} }).catch(() => {});
    expect(eventCreates(ws)[0]?.payload.presence_token).toBe("tok");
  });

  it("without getAuthToken (public chat) never sends the field", async () => {
    await connect({ userId: "u1", authToken: "static" });
    send("hi");
    expect(eventCreates(ws)).toHaveLength(1);
    expect("presence_token" in (eventCreates(ws)[0] as Frame).payload).toBe(false);
  });
});
