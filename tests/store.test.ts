import { describe, expect, it } from "vitest";
import { createWorkerStore } from "../src/store";
import type { Run, SettingsField, Thread, ThreadEvent } from "../src/types";

const thread = (id: string, lastEventAt = "2026-01-01T00:00:00Z"): Thread => ({
  id,
  workerId: "w1",
  metadata: { organizationId: "org1", workspaceId: "ws1", userId: "u1" },
  title: `Thread ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastEventAt,
});

const event = (
  id: string,
  threadId: string,
  actor: "user" | "assistant" = "user",
): ThreadEvent => ({
  id,
  threadId,
  runId: null,
  type: "message",
  actor,
  author: null,
  metadata: { userId: "u1", userName: "Alice", userEmail: "alice@test.com" },
  content: [{ type: "text", text: `Message ${id}` }],
  createdAt: "2026-01-01T00:00:00Z",
});

const run = (id: string, threadId: string, status: "running" | "succeeded" = "running"): Run => ({
  id,
  threadId,
  agentId: "agent-1",
  status,
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  error: null,
});

describe("createWorkerStore", () => {
  it("starts with idle connection", () => {
    const store = createWorkerStore();
    expect(store.getState().connection.status).toBe("idle");
  });

  it("setConnectionStatus updates status and error", () => {
    const store = createWorkerStore();
    store.getState().actions.setConnectionStatus("error", "fail");
    expect(store.getState().connection.status).toBe("error");
    expect(store.getState().connection.error).toBe("fail");
  });

  it("onThreadList populates threads and threadOrder", () => {
    const store = createWorkerStore();
    const t1 = thread("t1", "2026-01-02T00:00:00Z");
    const t2 = thread("t2", "2026-01-03T00:00:00Z");
    store.getState().actions.onThreadList([t2, t1]);
    expect(Object.keys(store.getState().threads)).toEqual(["t2", "t1"]);
    expect(store.getState().threadOrder).toEqual(["t2", "t1"]);
  });

  it("onThreadUpsert adds new thread", () => {
    const store = createWorkerStore();
    store.getState().actions.onThreadUpsert(thread("t1"));
    expect(store.getState().threads.t1).toBeDefined();
    expect(store.getState().threadOrder).toContain("t1");
  });

  it("onThreadUpsert updates existing thread", () => {
    const store = createWorkerStore();
    store.getState().actions.onThreadUpsert(thread("t1"));
    store.getState().actions.onThreadUpsert({ ...thread("t1"), title: "Updated" });
    expect(store.getState().threads.t1?.title).toBe("Updated");
  });

  it("onThreadDeleted removes thread and its events/runs", () => {
    const store = createWorkerStore();
    store.getState().actions.onThreadUpsert(thread("t1"));
    store.getState().actions.onThreadSnapshot(thread("t1"), [event("e1", "t1")], [run("r1", "t1")]);
    store.getState().actions.onThreadDeleted("t1");
    expect(store.getState().threads.t1).toBeUndefined();
    expect(store.getState().events.t1).toBeUndefined();
    expect(store.getState().runs.t1).toBeUndefined();
  });

  it("onThreadSnapshot sets events and runs for a thread", () => {
    const store = createWorkerStore();
    const t = thread("t1");
    const e = [event("e1", "t1"), event("e2", "t1")];
    const r = [run("r1", "t1")];
    store.getState().actions.onThreadSnapshot(t, e, r);
    expect(store.getState().events.t1).toHaveLength(2);
    expect(store.getState().runs.t1).toHaveLength(1);
    expect(store.getState().threads.t1).toBeDefined();
    expect(store.getState().loadingThreads.has("t1")).toBe(false);
  });

  it("onEventAppend appends and deduplicates events", () => {
    const store = createWorkerStore();
    store.getState().actions.onEventAppend("t1", [event("e1", "t1")]);
    store.getState().actions.onEventAppend("t1", [event("e1", "t1"), event("e2", "t1")]);
    expect(store.getState().events.t1).toHaveLength(2);
  });

  it("onRunUpsert adds new run", () => {
    const store = createWorkerStore();
    store.getState().actions.onRunUpsert(run("r1", "t1"));
    expect(store.getState().runs.t1).toHaveLength(1);
  });

  it("onRunUpsert updates existing run", () => {
    const store = createWorkerStore();
    store.getState().actions.onRunUpsert(run("r1", "t1"));
    store.getState().actions.onRunUpsert({ ...run("r1", "t1"), status: "succeeded" });
    expect(store.getState().runs.t1?.[0]?.status).toBe("succeeded");
  });

  it("optimistic add and remove", () => {
    const store = createWorkerStore();
    const e = event("opt-1", "t1");
    store.getState().actions.addOptimistic("t1", e, "client-1");
    expect(store.getState().optimistic.t1).toHaveLength(1);
    store.getState().actions.removeOptimistic("t1", "client-1");
    expect(store.getState().optimistic.t1).toHaveLength(0);
  });

  it("subscription tracking", () => {
    const store = createWorkerStore();
    store.getState().actions.addSubscription("t1");
    expect(store.getState().subscriptions.has("t1")).toBe(true);
    store.getState().actions.removeSubscription("t1");
    expect(store.getState().subscriptions.has("t1")).toBe(false);
  });

  it("resetReconnect resets attempts and failed flag", () => {
    const store = createWorkerStore();
    store.getState().actions.setConnectionStatus("connecting");
    store.getState().actions.setConnectionStatus("disconnected");
    const s = store.getState();
    s.actions.resetReconnect();
    expect(store.getState().connection.reconnectAttempts).toBe(0);
    expect(store.getState().connection.reconnectFailed).toBe(false);
  });

  it("onSettingsSnapshot sets fields and updatedAt", () => {
    const store = createWorkerStore();
    const field: SettingsField = {
      id: "f1",
      type: "text",
      label: "Name",
      required: false,
      readonly: false,
      value: "hello",
      placeholder: null,
      options: null,
      min: null,
      max: null,
      rows: null,
      src: null,
      width: null,
      height: null,
    };
    store.getState().actions.onSettingsSnapshot([field], "2026-01-01T00:00:00Z");
    expect(store.getState().settings.fields).toHaveLength(1);
    expect(store.getState().settings.updatedAt).toBe("2026-01-01T00:00:00Z");
    expect(store.getState().settings.isLoading).toBe(false);
  });

  it("onSettingsPatch updates field value", () => {
    const store = createWorkerStore();
    const field: SettingsField = {
      id: "f1",
      type: "text",
      label: "Name",
      required: false,
      readonly: false,
      value: "old",
      placeholder: null,
      options: null,
      min: null,
      max: null,
      rows: null,
      src: null,
      width: null,
      height: null,
    };
    store.getState().actions.onSettingsSnapshot([field], "2026-01-01T00:00:00Z");
    store.getState().actions.onSettingsPatch("f1", "new", "2026-01-02T00:00:00Z");
    const f = store.getState().settings.fields[0] as SettingsField;
    expect(f.value).toBe("new");
    expect(store.getState().settings.updatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("onSettingsPatch updates field inside group", () => {
    const store = createWorkerStore();
    const group = {
      id: "g1",
      label: "Group",
      fields: [
        {
          id: "f1",
          type: "text" as const,
          label: "Name",
          required: false,
          readonly: false,
          value: "old",
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
      collapsible: null,
    };
    store.getState().actions.onSettingsSnapshot([group], "2026-01-01T00:00:00Z");
    store.getState().actions.onSettingsPatch("f1", "new", "2026-01-02T00:00:00Z");
    const g = store.getState().settings.fields[0] as { fields: SettingsField[] };
    expect(g.fields[0]?.value).toBe("new");
  });

  it("onFeedbackAck stores feedback by target ID", () => {
    const store = createWorkerStore();
    store.getState().actions.onFeedbackAck("e1", "like");
    expect(store.getState().feedback.e1).toBe("like");
    store.getState().actions.onFeedbackAck("e1", "dislike");
    expect(store.getState().feedback.e1).toBe("dislike");
  });

  it("onAnalyticsEvent appends and increments counters", () => {
    const store = createWorkerStore();
    store.getState().actions.onAnalyticsEvent({
      event: "message.c2s",
      timestamp: "2026-01-01T00:00:00Z",
      workerId: "w1",
      threadId: "t1",
      userId: "u1",
      runId: null,
      eventId: null,
      data: null,
    });
    expect(store.getState().analytics.events).toHaveLength(1);
    expect(store.getState().analytics.counters.totalRequests).toBe(1);
  });

  it("onAnalyticsEvent trims to 50 events", () => {
    const store = createWorkerStore();
    for (let i = 0; i < 55; i++) {
      store.getState().actions.onAnalyticsEvent({
        event: "message.c2s",
        timestamp: "2026-01-01T00:00:00Z",
        workerId: "w1",
        threadId: null,
        userId: null,
        runId: null,
        eventId: null,
        data: null,
      });
    }
    expect(store.getState().analytics.events).toHaveLength(50);
    expect(store.getState().analytics.counters.totalRequests).toBe(55);
  });

  it("onAnalyticsEvent counts feedback separately", () => {
    const store = createWorkerStore();
    store.getState().actions.onAnalyticsEvent({
      event: "feedback.like",
      timestamp: "2026-01-01T00:00:00Z",
      workerId: "w1",
      threadId: null,
      userId: null,
      runId: null,
      eventId: null,
      data: null,
    });
    store.getState().actions.onAnalyticsEvent({
      event: "feedback.dislike",
      timestamp: "2026-01-01T00:00:00Z",
      workerId: "w1",
      threadId: null,
      userId: null,
      runId: null,
      eventId: null,
      data: null,
    });
    expect(store.getState().analytics.counters.feedbackLikes).toBe(1);
    expect(store.getState().analytics.counters.feedbackDislikes).toBe(1);
    expect(store.getState().analytics.counters.totalRequests).toBe(0);
  });

  it("onThreadList stores cursor and hasMore", () => {
    const store = createWorkerStore();
    store.getState().actions.onThreadList([thread("t1"), thread("t2")], "cursor-123");
    expect(store.getState().threadListCursor).toBe("cursor-123");
    expect(store.getState().threadListHasMore).toBe(true);
  });

  it("onThreadListAppend adds threads without replacing", () => {
    const store = createWorkerStore();
    store.getState().actions.onThreadList([thread("t1")]);
    store.getState().actions.onThreadListAppend([thread("t2")], null);
    expect(store.getState().threadOrder).toEqual(["t1", "t2"]);
    expect(store.getState().threadListHasMore).toBe(false);
  });

  it("onThreadList stores totalCount", () => {
    const store = createWorkerStore();
    store.getState().actions.onThreadList([thread("t1"), thread("t2")], "cursor-123", 42);
    expect(store.getState().threadListTotalCount).toBe(42);
  });

  it("onThreadListAppend preserves totalCount when not provided", () => {
    const store = createWorkerStore();
    store.getState().actions.onThreadList([thread("t1")], "cursor-1", 100);
    store.getState().actions.onThreadListAppend([thread("t2")], null);
    expect(store.getState().threadListTotalCount).toBe(100);
  });

  it("onEventListResult prepends older events", () => {
    const store = createWorkerStore();
    store.getState().actions.onEventAppend("t1", [event("e3", "t1"), event("e4", "t1")]);
    store
      .getState()
      .actions.onEventListResult("t1", [event("e1", "t1"), event("e2", "t1")], "e1", true);
    const events = store.getState().events.t1 ?? [];
    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(store.getState().eventPagination.t1).toEqual({ cursor: "e1", hasMore: true });
  });

  it("onEventListResult deduplicates overlapping events", () => {
    const store = createWorkerStore();
    store.getState().actions.onEventAppend("t1", [event("e2", "t1"), event("e3", "t1")]);
    store
      .getState()
      .actions.onEventListResult("t1", [event("e1", "t1"), event("e2", "t1")], null, false);
    const events = store.getState().events.t1 ?? [];
    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(store.getState().eventPagination.t1).toEqual({ cursor: null, hasMore: false });
  });

  it("onThreadDeleted cleans up eventPagination", () => {
    const store = createWorkerStore();
    store.getState().actions.onEventListResult("t1", [event("e1", "t1")], "e1", true);
    expect(store.getState().eventPagination.t1).toBeDefined();
    store.getState().actions.onThreadUpsert(thread("t1"));
    store.getState().actions.onThreadDeleted("t1");
    expect(store.getState().eventPagination.t1).toBeUndefined();
  });
});
