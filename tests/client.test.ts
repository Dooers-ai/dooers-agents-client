import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "../src/client";
import type { AgentActions } from "../src/store";

function createMockCallbacks(): AgentActions {
  return {
    setConnectionStatus: vi.fn(),
    setReconnectFailed: vi.fn(),
    resetReconnect: vi.fn(),
    onThreadList: vi.fn(),
    onThreadListAppend: vi.fn(),
    onThreadUpsert: vi.fn(),
    onThreadDeleted: vi.fn(),
    onThreadSnapshot: vi.fn(),
    onEventAppend: vi.fn(),
    onEventListResult: vi.fn(),
    onRunUpsert: vi.fn(),
    addOptimistic: vi.fn(),
    removeOptimistic: vi.fn(),
    addSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    onSettingsSnapshot: vi.fn(),
    onSettingsPatch: vi.fn(),
    onFeedbackAck: vi.fn(),
    onAnalyticsEvent: vi.fn(),
    resetAnalytics: vi.fn(),
  };
}

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    // Simulate async open
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  // Test helper: simulate server message
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("AgentClient", () => {
  let callbacks: AgentActions;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  it("sends connect frame on open", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1", {
      organizationId: "org1",
      workspaceId: "ws1",
      userId: "u1",
      userName: "Alice",
      userEmail: "alice@test.com",
      userRole: "member",
    });

    expect(callbacks.setConnectionStatus).toHaveBeenCalledWith("connecting");

    // Wait for async open
    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0] as string);
    expect(frame.type).toBe("connect");
    expect(frame.payload.agent_id).toBe("w1");
    expect(frame.payload.metadata.organization_id).toBe("org1");
  });

  it("routes ack frame and requests thread list", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");

    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;
    const connectId = JSON.parse(ws.sent[0] as string).id;

    ws.receive({ id: "ack-1", type: "ack", payload: { ack_id: connectId, ok: true } });

    expect(callbacks.setConnectionStatus).toHaveBeenCalledWith("connected");
    expect(callbacks.resetReconnect).toHaveBeenCalled();
    // Should have sent thread.list
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[1] as string).type).toBe("thread.list");
  });

  it("routes thread.list.result", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;
    ws.receive({
      id: "tlr-1",
      type: "thread.list.result",
      payload: {
        threads: [
          {
            id: "t1",
            agent_id: "w1",
            metadata: {
              organization_id: "org1",
              workspace_id: "ws1",
              user_id: "u1",
            },
            title: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            last_event_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });

    expect(callbacks.onThreadList).toHaveBeenCalled();
  });

  it("refcounts subscriptions", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    client.subscribe("t1");
    client.subscribe("t1");

    // Only one subscribe frame sent
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    const subscribeFrames = ws.sent.filter((s) => JSON.parse(s).type === "thread.subscribe");
    expect(subscribeFrames).toHaveLength(1);

    client.unsubscribe("t1");
    // Still subscribed (refcount = 1)
    const unsubFrames = ws.sent.filter((s) => JSON.parse(s).type === "thread.unsubscribe");
    expect(unsubFrames).toHaveLength(0);

    client.unsubscribe("t1");
    // Now unsubscribed
    const unsubFrames2 = ws.sent.filter((s) => JSON.parse(s).type === "thread.unsubscribe");
    expect(unsubFrames2).toHaveLength(1);
  });

  it("disconnect cleans up", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    client.disconnect();
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    expect(ws.readyState).toBe(3); // CLOSED
    expect(callbacks.setConnectionStatus).toHaveBeenCalledWith("disconnected");
  });

  it("sends settings.subscribe and routes settings.snapshot", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    client.subscribeSettings();
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    const subFrames = ws.sent.filter((s) => JSON.parse(s).type === "settings.subscribe");
    expect(subFrames).toHaveLength(1);
    expect(JSON.parse(subFrames[0] as string).payload).toEqual({
      agent_id: "w1",
      audience: "user",
      agent_owner_user_id: null,
    })

    ws.receive({
      id: "ss-1",
      type: "settings.snapshot",
      payload: {
        agent_id: "w1",
        fields: [
          {
            id: "f1",
            type: "text",
            label: "Name",
            required: false,
            readonly: false,
            value: "hi",
            placeholder: null,
            options: null,
            min: null,
            max: null,
            rows: null,
            src: null,
            width: null,
            height: null,
          },
        ],
        updated_at: "2026-01-01T00:00:00Z",
      },
    });

    expect(callbacks.onSettingsSnapshot).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "f1", value: "hi" })]),
      "2026-01-01T00:00:00Z",
    );
  });

  it("sends settings.patch and routes settings.patch response", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    client.patchSetting("f1", "new-value");
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    const patchFrames = ws.sent.filter((s) => JSON.parse(s).type === "settings.patch");
    expect(patchFrames).toHaveLength(1);
    expect(JSON.parse(patchFrames[0] as string).payload).toEqual({
      field_id: "f1",
      value: "new-value",
    });

    ws.receive({
      id: "sp-1",
      type: "settings.patch",
      payload: {
        agent_id: "w1",
        field_id: "f1",
        value: "new-value",
        updated_at: "2026-01-02T00:00:00Z",
      },
    });

    expect(callbacks.onSettingsPatch).toHaveBeenCalledWith(
      "f1",
      "new-value",
      "2026-01-02T00:00:00Z",
    );
  });

  it("sends feedback and routes feedback.ack", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    client.sendFeedback("event", "e1", "like", "good answer");
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    const fbFrames = ws.sent.filter((s) => JSON.parse(s).type === "feedback");
    expect(fbFrames).toHaveLength(1);
    expect(JSON.parse(fbFrames[0] as string).payload).toEqual({
      target_type: "event",
      target_id: "e1",
      feedback: "like",
      reason: "good answer",
    });

    ws.receive({
      id: "fb-1",
      type: "feedback.ack",
      payload: { target_type: "event", target_id: "e1", feedback: "like", ok: true },
    });

    expect(callbacks.onFeedbackAck).toHaveBeenCalledWith("e1", "like");
  });

  it("routes thread.list.result with total_count", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;
    ws.receive({
      id: "tlr-1",
      type: "thread.list.result",
      payload: {
        threads: [
          {
            id: "t1",
            agent_id: "w1",
            metadata: { organization_id: "org1", workspace_id: "ws1", user_id: "u1" },
            title: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            last_event_at: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "2026-01-01T00:00:00Z",
        total_count: 42,
      },
    });

    expect(callbacks.onThreadList).toHaveBeenCalledWith(
      expect.any(Array),
      "2026-01-01T00:00:00Z",
      42,
    );
  });

  it("routes event.list.result", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;
    ws.receive({
      id: "elr-1",
      type: "event.list.result",
      payload: {
        thread_id: "t1",
        events: [
          {
            id: "e1",
            thread_id: "t1",
            run_id: null,
            type: "message",
            actor: "user",
            author: null,
            metadata: { user_id: "u1" },
            content: [{ type: "text", text: "hello" }],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "e1",
        has_more: true,
      },
    });

    expect(callbacks.onEventListResult).toHaveBeenCalledWith(
      "t1",
      expect.arrayContaining([expect.objectContaining({ id: "e1" })]),
      "e1",
      true,
    );
  });

  it("loadOlderEvents sends event.list frame", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;

    // First, simulate receiving an event.list.result to set the cursor
    ws.receive({
      id: "elr-1",
      type: "event.list.result",
      payload: {
        thread_id: "t1",
        events: [],
        cursor: "e5",
        has_more: true,
      },
    });

    client.loadOlderEvents("t1", 25);

    const eventListFrames = ws.sent.filter((s) => JSON.parse(s).type === "event.list");
    expect(eventListFrames).toHaveLength(1);
    const frame = JSON.parse(eventListFrames[0] as string);
    expect(frame.payload.thread_id).toBe("t1");
    expect(frame.payload.before_event_id).toBe("e5");
    expect(frame.payload.limit).toBe(25);
  });

  it("sendMessage returns promise that resolves with threadId on event.append", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1", { userId: "u1", userName: "Alice" });
    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;

    const promise = client.sendMessage({ text: "hello" });

    // Extract the clientEventId from the sent frame
    const createFrame = ws.sent
      .map((s) => JSON.parse(s))
      .find((f: { type: string }) => f.type === "event.create");
    const clientEventId = createFrame.payload.client_event_id;

    // Simulate server responding with event.append
    ws.receive({
      id: "ea-1",
      type: "event.append",
      payload: {
        thread_id: "new-thread-123",
        events: [
          {
            id: "e1",
            thread_id: "new-thread-123",
            run_id: null,
            type: "message",
            actor: "user",
            author: null,
            metadata: { user_id: "u1" },
            content: [{ type: "text", text: "hello" }],
            created_at: "2026-01-01T00:00:00Z",
            client_event_id: clientEventId,
          },
        ],
      },
    });

    const result = await promise;
    expect(result).toEqual({ threadId: "new-thread-123" });
  });

  it("sendMessage resolves with existing threadId when sent to existing thread", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1", { userId: "u1" });
    await new Promise((r) => setTimeout(r, 10));

    const ws = MockWebSocket.instances[0] as MockWebSocket;

    const promise = client.sendMessage({ text: "hello", threadId: "existing-t1" });

    const createFrame = ws.sent
      .map((s) => JSON.parse(s))
      .find((f: { type: string }) => f.type === "event.create");
    const clientEventId = createFrame.payload.client_event_id;

    ws.receive({
      id: "ea-2",
      type: "event.append",
      payload: {
        thread_id: "existing-t1",
        events: [
          {
            id: "e2",
            thread_id: "existing-t1",
            run_id: null,
            type: "message",
            actor: "user",
            author: null,
            metadata: { user_id: "u1" },
            content: [{ type: "text", text: "hello" }],
            created_at: "2026-01-01T00:00:00Z",
            client_event_id: clientEventId,
          },
        ],
      },
    });

    const result = await promise;
    expect(result).toEqual({ threadId: "existing-t1" });
  });

  it("sends analytics.subscribe and routes analytics.event", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    client.subscribeAnalytics();
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    const subFrames = ws.sent.filter((s) => JSON.parse(s).type === "analytics.subscribe");
    expect(subFrames).toHaveLength(1);

    ws.receive({
      id: "ae-1",
      type: "analytics.event",
      payload: {
        event: "message.c2s",
        timestamp: "2026-01-01T00:00:00Z",
        agent_id: "w1",
        thread_id: "t1",
        user_id: "u1",
        run_id: null,
        event_id: null,
        data: null,
      },
    });

    expect(callbacks.onAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "message.c2s", agentId: "w1", threadId: "t1" }),
    );
  });
});
