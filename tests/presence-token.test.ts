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

  it("hung getAuthToken: queued sends all go out within 15s, in order, without the token; a later send retries", async () => {
    let calls = 0;
    const getAuthToken = vi.fn(() => {
      if (++calls === 1) return Promise.resolve("t1");
      if (calls === 2) return new Promise<string>(() => {});
      return Promise.resolve("t3");
    });
    await connect({ userId: "u1", getAuthToken });
    await vi.advanceTimersByTimeAsync(61_000);
    send("a");
    send("b");
    send("c");
    await vi.advanceTimersByTimeAsync(15_500);
    const frames = eventCreates(ws);
    const texts = frames.map((f) => ((f.payload.event as { content: { text: string }[] }).content[0] as { text: string }).text);
    expect(texts).toEqual(["a", "b", "c"]);
    expect(frames.every((f) => !("presence_token" in f.payload))).toBe(true);
    expect(getAuthToken).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(16_000);
    send("d");
    await vi.advanceTimersByTimeAsync(1);
    expect(getAuthToken).toHaveBeenCalledTimes(3);
    expect(eventCreates(ws)[3]?.payload.presence_token).toBe("t3");
  });

  it("a send queued before disconnect rejects at once instead of timing out", async () => {
    let calls = 0;
    const getAuthToken = vi.fn(() => {
      if (++calls === 1) return Promise.resolve("t1");
      return new Promise<string>((r) => setTimeout(() => r("late"), 5_000));
    });
    await connect({ userId: "u1", getAuthToken });
    await vi.advanceTimersByTimeAsync(61_000);
    const p = client.sendMessage({ threadId: "t-1", text: "x" });
    const settled = vi.fn();
    p.catch((e: Error) => settled(e.message));
    ws.drop();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalledWith(expect.stringContaining("timed out"));
    // the rejected message is never sent late, on any socket
    expect(MockWebSocket.instances.flatMap(eventCreates)).toHaveLength(0);
  });

  it("form responses carry presence_token too", async () => {
    await connect({ userId: "u1", getAuthToken: async () => "tok" });
    client.sendFormResponse({ threadId: "t-1", formEventId: "f1", cancelled: false, values: {} }).catch(() => {});
    expect(eventCreates(ws)[0]?.payload.presence_token).toBe("tok");
  });

  it("a new connection never reuses the previous connection's token", async () => {
    await connect({ userId: "u1", getAuthToken: async () => "tA" });
    client.disconnect();
    // the next agent's provider yields no token on the handshake
    client.connect("wss://test.com/ws", "agent-2", { userId: "u1", getAuthToken: async () => undefined });
    await vi.advanceTimersByTimeAsync(1);
    ws = MockWebSocket.instances[1] as MockWebSocket;
    ws.autoPong = true;
    ackConnect(ws, true);
    send("hi");
    await vi.advanceTimersByTimeAsync(1);
    const [frame] = eventCreates(ws);
    expect(frame).toBeDefined();
    expect((frame as Frame).payload.presence_token).not.toBe("tA");
  });

  it("a new connection forgets the previous connection's failed fetch", async () => {
    let calls = 0;
    await connect({
      userId: "u1",
      getAuthToken: async () => {
        if (++calls === 1) return "tA";
        throw new Error("boom");
      },
    });
    await vi.advanceTimersByTimeAsync(61_000);
    send("old");
    await vi.advanceTimersByTimeAsync(1);
    client.disconnect();

    let callsB = 0;
    const getAuthTokenB = vi.fn(async () => (++callsB === 1 ? undefined : "tB"));
    client.connect("wss://test.com/ws", "agent-2", { userId: "u1", getAuthToken: getAuthTokenB });
    await vi.advanceTimersByTimeAsync(1);
    ws = MockWebSocket.instances[1] as MockWebSocket;
    ws.autoPong = true;
    ackConnect(ws, true);
    send("new");
    await vi.advanceTimersByTimeAsync(1);
    expect(getAuthTokenB).toHaveBeenCalledTimes(2);
    expect(eventCreates(ws)[0]?.payload.presence_token).toBe("tB");
  });

  it("a token fetched for the previous connection is dropped when it lands late", async () => {
    let resolveLate: (t: string) => void = () => {};
    let calls = 0;
    await connect({
      userId: "u1",
      getAuthToken: () => {
        if (++calls === 1) return Promise.resolve("tA");
        return new Promise<string>((r) => {
          resolveLate = r;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(61_000);
    send("old");
    await vi.advanceTimersByTimeAsync(1);
    client.disconnect();

    client.connect("wss://test.com/ws", "agent-2", { userId: "u1", getAuthToken: async () => undefined });
    await vi.advanceTimersByTimeAsync(1);
    ws = MockWebSocket.instances[1] as MockWebSocket;
    ws.autoPong = true;
    ackConnect(ws, true);
    resolveLate("tA-late");
    await vi.advanceTimersByTimeAsync(1);
    send("new");
    await vi.advanceTimersByTimeAsync(1);
    expect(eventCreates(ws)[0]?.payload.presence_token).toBeUndefined();
  });

  it("without getAuthToken (public chat) never sends the field", async () => {
    await connect({ userId: "u1", authToken: "static" });
    send("hi");
    expect(eventCreates(ws)).toHaveLength(1);
    expect("presence_token" in (eventCreates(ws)[0] as Frame).payload).toBe(false);
  });
});
