# Complete Protocol Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `agents-server-client` handle the full server protocol (settings, feedback, analytics) and improve on what the raw `dooers-app-web` client does — adding pagination, per-thread waiting state, and fixing the stale connect frame type.

**Architecture:** Each new module follows the established pattern: wire types in `protocol/models.ts` → frame types in `protocol/frames.ts` → public types + transforms in `types.ts` → client methods + route cases in `client.ts` → store state + actions in `store.ts` → React hook in `hooks/` → exports in `main.ts`. Tests validate store actions and client routing.

**Tech Stack:** TypeScript, React 18/19, Zustand 5, Vitest, Biome

**Reference files:**
- Server protocol: `../agents-server/src/dooers/protocol/frames.py` (all C2S/S2C frame types)
- Server settings models: `../agents-server/src/dooers/features/settings/models.py`
- Server analytics models: `../agents-server/src/dooers/features/analytics/models.py`
- Raw client reference: `../dooers-app-web/src/services/agent/websocket.service.ts`
- Raw store reference: `../dooers-app-web/src/stores/chat.store.ts`
- Raw types reference: `../dooers-app-web/src/types/websocket.types.ts`

---

### Task 1: Fix C2S_Connect Frame Type

The `frames.ts` C2S_Connect type still has flat metadata fields but `client.ts` sends nested `metadata: { ... }`. Fix the type to match reality.

**Files:**
- Modify: `src/protocol/frames.ts:13-26`

**Step 1: Update C2S_Connect payload type**

Replace in `src/protocol/frames.ts`:

```typescript
export type C2S_Connect = Frame<
  "connect",
  {
    agent_id: string;
    metadata: {
      organization_id: string;
      workspace_id: string;
      user_id: string;
      user_name: string;
      user_email: string;
      user_role: string;
    };
    auth_token?: string;
    client?: { name: string; version: string };
  }
>;
```

**Step 2: Run tests to verify nothing breaks**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit && npx vitest run`
Expected: PASS (18 tests, 0 type errors)

**Step 3: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/protocol/frames.ts
git commit -m "fix: align C2S_Connect type with nested metadata payload"
```

---

### Task 2: Settings Wire Types + Public Types + Transforms

Add all settings types to both protocol and public layers.

**Files:**
- Modify: `src/protocol/models.ts` (add wire types)
- Modify: `src/types.ts` (add public types + transforms)

**Step 1: Add wire types to `src/protocol/models.ts`**

Append after `WireRun`:

```typescript
// --- Settings ---

export interface WireSettingsSelectOption {
  value: string;
  label: string;
}

export interface WireSettingsField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  readonly: boolean;
  value: unknown;
  placeholder: string | null;
  options: WireSettingsSelectOption[] | null;
  min: number | null;
  max: number | null;
  rows: number | null;
  src: string | null;
  width: number | null;
  height: number | null;
}

export interface WireSettingsFieldGroup {
  id: string;
  label: string;
  fields: WireSettingsField[];
  collapsible: "open" | "closed" | null;
}

export type WireSettingsItem = WireSettingsField | WireSettingsFieldGroup;
```

**Step 2: Add public types to `src/types.ts`**

Add after the `Run` interface (before `ThreadState`):

```typescript
// --- Settings ---

export type SettingsFieldType =
  | "text"
  | "number"
  | "select"
  | "checkbox"
  | "textarea"
  | "password"
  | "email"
  | "date"
  | "image";

export interface SettingsSelectOption {
  value: string;
  label: string;
}

export interface SettingsField {
  id: string;
  type: SettingsFieldType;
  label: string;
  required: boolean;
  readonly: boolean;
  value: unknown;
  placeholder: string | null;
  options: SettingsSelectOption[] | null;
  min: number | null;
  max: number | null;
  rows: number | null;
  src: string | null;
  width: number | null;
  height: number | null;
}

export interface SettingsFieldGroup {
  id: string;
  label: string;
  fields: SettingsField[];
  collapsible: "open" | "closed" | null;
}

export type SettingsItem = SettingsField | SettingsFieldGroup;

export function isSettingsFieldGroup(item: SettingsItem): item is SettingsFieldGroup {
  return "fields" in item && Array.isArray((item as SettingsFieldGroup).fields);
}
```

**Step 3: Add transforms to `src/types.ts`**

Add the import for wire types at the existing import line:

```typescript
import type {
  WireContentPart,
  WireMetadata,
  WireRun,
  WireSettingsField,
  WireSettingsFieldGroup,
  WireSettingsItem,
  WireThread,
  WireThreadEvent,
} from "./protocol/models";
```

Add transform functions after `toWireContentPart`:

```typescript
// --- Settings transforms ---

export function toSettingsField(w: WireSettingsField): SettingsField {
  return {
    id: w.id,
    type: w.type as SettingsFieldType,
    label: w.label,
    required: w.required,
    readonly: w.readonly,
    value: w.value,
    placeholder: w.placeholder,
    options: w.options,
    min: w.min,
    max: w.max,
    rows: w.rows,
    src: w.src,
    width: w.width,
    height: w.height,
  };
}

export function toSettingsItem(w: WireSettingsItem): SettingsItem {
  if ("fields" in w && Array.isArray((w as WireSettingsFieldGroup).fields)) {
    const g = w as WireSettingsFieldGroup;
    return {
      id: g.id,
      label: g.label,
      fields: g.fields.map(toSettingsField),
      collapsible: g.collapsible,
    };
  }
  return toSettingsField(w as WireSettingsField);
}
```

**Step 4: Verify types compile**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/protocol/models.ts src/types.ts
git commit -m "feat: add settings wire types, public types, and transforms"
```

---

### Task 3: Settings Frames (C2S + S2C)

Add settings frame types to the protocol layer.

**Files:**
- Modify: `src/protocol/frames.ts`

**Step 1: Add imports and frame types**

Add `WireSettingsItem` to the import from `./models`:

```typescript
import type { WireContentPart, WireRun, WireSettingsItem, WireThread, WireThreadEvent } from "./models";
```

Add C2S frames after `C2S_EventCreate`:

```typescript
// --- Settings C2S ---

export type C2S_SettingsSubscribe = Frame<"settings.subscribe", { agent_id: string }>;

export type C2S_SettingsUnsubscribe = Frame<"settings.unsubscribe", { agent_id: string }>;

export type C2S_SettingsPatch = Frame<"settings.patch", { field_id: string; value: unknown }>;
```

Add S2C frames after `S2C_RunUpsert`:

```typescript
// --- Settings S2C ---

export type S2C_SettingsSnapshot = Frame<
  "settings.snapshot",
  { agent_id: string; fields: WireSettingsItem[]; updated_at: string }
>;

export type S2C_SettingsPatch = Frame<
  "settings.patch",
  { agent_id: string; field_id: string; value: unknown; updated_at: string }
>;
```

Update the `ClientToServer` union:

```typescript
export type ClientToServer =
  | C2S_Connect
  | C2S_ThreadList
  | C2S_ThreadSubscribe
  | C2S_ThreadUnsubscribe
  | C2S_ThreadDelete
  | C2S_EventCreate
  | C2S_SettingsSubscribe
  | C2S_SettingsUnsubscribe
  | C2S_SettingsPatch;
```

Update the `ServerToClient` union:

```typescript
export type ServerToClient =
  | S2C_Ack
  | S2C_ThreadListResult
  | S2C_ThreadSnapshot
  | S2C_EventAppend
  | S2C_ThreadUpsert
  | S2C_ThreadDeleted
  | S2C_RunUpsert
  | S2C_SettingsSnapshot
  | S2C_SettingsPatch;
```

**Step 2: Verify types compile**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/protocol/frames.ts
git commit -m "feat: add settings C2S and S2C frame types"
```

---

### Task 4: Settings Store Slice + Tests

Add settings state and actions to the store, with tests.

**Files:**
- Modify: `src/store.ts`
- Modify: `tests/store.test.ts`

**Step 1: Write the failing tests**

Add to `tests/store.test.ts` — import `SettingsField` type and add tests:

```typescript
import type { Run, SettingsField, Thread, ThreadEvent } from "../src/types";
```

Add at end of describe block:

```typescript
  it("onSettingsSnapshot sets fields and updatedAt", () => {
    const store = createAgentStore();
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
    const store = createAgentStore();
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
    const store = createAgentStore();
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
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx vitest run`
Expected: FAIL — `onSettingsSnapshot` and `onSettingsPatch` do not exist on actions

**Step 3: Add settings state and actions to `src/store.ts`**

Add imports:

```typescript
import type { Run, SettingsItem, Thread, ThreadEvent } from "./types";
import { isSettingsFieldGroup } from "./types";
```

Add to `AgentActions` interface:

```typescript
  onSettingsSnapshot: (fields: SettingsItem[], updatedAt: string) => void;
  onSettingsPatch: (fieldId: string, value: unknown, updatedAt: string) => void;
```

Add to `AgentState` interface:

```typescript
  settings: {
    fields: SettingsItem[];
    updatedAt: string | null;
    isLoading: boolean;
  };
```

Add initial state inside `createAgentStore`:

```typescript
    settings: {
      fields: [],
      updatedAt: null,
      isLoading: true,
    },
```

Add action implementations inside the `actions` object:

```typescript
      onSettingsSnapshot: (fields, updatedAt) =>
        set(() => ({
          settings: { fields, updatedAt, isLoading: false },
        })),

      onSettingsPatch: (fieldId, value, updatedAt) =>
        set((s) => ({
          settings: {
            ...s.settings,
            updatedAt,
            fields: s.settings.fields.map((item) => {
              if (isSettingsFieldGroup(item)) {
                const hasField = item.fields.some((f) => f.id === fieldId);
                if (hasField) {
                  return {
                    ...item,
                    fields: item.fields.map((f) =>
                      f.id === fieldId ? { ...f, value } : f,
                    ),
                  };
                }
                return item;
              }
              return item.id === fieldId ? { ...item, value } : item;
            }),
          },
        })),
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx vitest run`
Expected: PASS (all tests including 3 new settings tests)

**Step 5: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/store.ts tests/store.test.ts
git commit -m "feat: add settings store slice with snapshot and patch actions"
```

---

### Task 5: Settings Client Methods + Route Handling + Tests

Wire settings into the client: send methods, route incoming frames.

**Files:**
- Modify: `src/client.ts`
- Modify: `tests/client.test.ts`

**Step 1: Write the failing tests**

Add to `tests/client.test.ts` — update `createMockCallbacks` to include new actions:

```typescript
    onSettingsSnapshot: vi.fn(),
    onSettingsPatch: vi.fn(),
```

Add test cases:

```typescript
  it("sends settings.subscribe and routes settings.snapshot", async () => {
    const client = new AgentClient(callbacks);
    client.connect("wss://test.com/ws", "w1");
    await new Promise((r) => setTimeout(r, 10));

    client.subscribeSettings();
    const ws = MockWebSocket.instances[0] as MockWebSocket;
    const subFrames = ws.sent.filter((s) => JSON.parse(s).type === "settings.subscribe");
    expect(subFrames).toHaveLength(1);
    expect(JSON.parse(subFrames[0] as string).payload.agent_id).toBe("w1");

    ws.receive({
      id: "ss-1",
      type: "settings.snapshot",
      payload: {
        agent_id: "w1",
        fields: [{ id: "f1", type: "text", label: "Name", required: false, readonly: false, value: "hi", placeholder: null, options: null, min: null, max: null, rows: null, src: null, width: null, height: null }],
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

    expect(callbacks.onSettingsPatch).toHaveBeenCalledWith("f1", "new-value", "2026-01-02T00:00:00Z");
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx vitest run`
Expected: FAIL — `subscribeSettings` and `patchSetting` do not exist

**Step 3: Add client methods and route cases to `src/client.ts`**

Add import for `toSettingsItem`:

```typescript
import { toRun, toSettingsItem, toThread, toThreadEvent, toWireContentPart } from "./types";
```

Add public methods after `deleteThread`:

```typescript
  // --- Settings ---

  subscribeSettings() {
    this.send("settings.subscribe", { agent_id: this.agentId });
  }

  unsubscribeSettings() {
    this.send("settings.unsubscribe", { agent_id: this.agentId });
  }

  patchSetting(fieldId: string, value: unknown) {
    this.send("settings.patch", { field_id: fieldId, value });
  }
```

Add route cases inside `route()` switch, after `case "run.upsert"`:

```typescript
      case "settings.snapshot": {
        const fields = frame.payload.fields.map(toSettingsItem);
        this.callbacks.onSettingsSnapshot(fields, frame.payload.updated_at);
        break;
      }

      case "settings.patch":
        this.callbacks.onSettingsPatch(
          frame.payload.field_id,
          frame.payload.value,
          frame.payload.updated_at,
        );
        break;
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/client.ts tests/client.test.ts
git commit -m "feat: add settings client methods and route handling"
```

---

### Task 6: useSettings Hook + Exports

Create the settings hook and wire up exports.

**Files:**
- Create: `src/hooks/use-settings.ts`
- Modify: `src/main.ts`

**Step 1: Create `src/hooks/use-settings.ts`**

```typescript
import { useCallback } from "react";
import { useShallowStore, useStore, useAgentContext } from "../provider";

export function useSettings() {
  const { client } = useAgentContext();

  const fields = useShallowStore((s) => s.settings.fields);
  const updatedAt = useStore((s) => s.settings.updatedAt);
  const isLoading = useStore((s) => s.settings.isLoading);

  const subscribe = useCallback(() => client.subscribeSettings(), [client]);
  const unsubscribe = useCallback(() => client.unsubscribeSettings(), [client]);

  const patchField = useCallback(
    (fieldId: string, value: unknown) => client.patchSetting(fieldId, value),
    [client],
  );

  return { fields, updatedAt, isLoading, subscribe, unsubscribe, patchField };
}
```

**Step 2: Update `src/main.ts`**

Add hook export:

```typescript
export { useSettings } from "./hooks/use-settings";
```

Add type exports:

```typescript
export type {
  SettingsFieldType,
  SettingsSelectOption,
  SettingsField,
  SettingsFieldGroup,
  SettingsItem,
} from "./types";
export { isSettingsFieldGroup } from "./types";
```

**Step 3: Verify**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/hooks/use-settings.ts src/main.ts
git commit -m "feat: add useSettings hook and exports"
```

---

### Task 7: Feedback — Types, Frames, Store, Client, Hook

Feedback is a small module (1 C2S + 1 S2C). Implement all layers in one task.

**Files:**
- Modify: `src/protocol/frames.ts` (add C2S_Feedback, S2C_FeedbackAck)
- Modify: `src/types.ts` (add FeedbackType, FeedbackTarget)
- Modify: `src/store.ts` (add feedback state + action)
- Modify: `src/client.ts` (add sendFeedback + route)
- Create: `src/hooks/use-feedback.ts`
- Modify: `src/main.ts` (add exports)

**Step 1: Add frame types to `src/protocol/frames.ts`**

Add C2S after settings frames:

```typescript
// --- Feedback C2S ---

export type C2S_Feedback = Frame<
  "feedback",
  {
    target_type: string;
    target_id: string;
    feedback: "like" | "dislike";
    reason?: string;
  }
>;
```

Add S2C after settings frames:

```typescript
// --- Feedback S2C ---

export type S2C_FeedbackAck = Frame<
  "feedback.ack",
  {
    target_type: string;
    target_id: string;
    feedback: string;
    ok: boolean;
  }
>;
```

Update unions — add `C2S_Feedback` to `ClientToServer`, add `S2C_FeedbackAck` to `ServerToClient`.

**Step 2: Add public types to `src/types.ts`**

After settings types:

```typescript
// --- Feedback ---

export type FeedbackType = "like" | "dislike";
export type FeedbackTarget = "event" | "run" | "thread";
```

**Step 3: Add store slice to `src/store.ts`**

Add to `AgentState`:

```typescript
  feedback: Record<string, "like" | "dislike">;
```

Add to `AgentActions`:

```typescript
  onFeedbackAck: (targetId: string, feedback: "like" | "dislike") => void;
```

Add initial state:

```typescript
    feedback: {},
```

Add action:

```typescript
      onFeedbackAck: (targetId, feedback) =>
        set((s) => ({
          feedback: { ...s.feedback, [targetId]: feedback },
        })),
```

**Step 4: Add client methods to `src/client.ts`**

Add public method:

```typescript
  // --- Feedback ---

  sendFeedback(
    targetType: string,
    targetId: string,
    feedback: "like" | "dislike",
    reason?: string,
  ) {
    this.send("feedback", {
      target_type: targetType,
      target_id: targetId,
      feedback,
      reason,
    });
  }
```

Add route case:

```typescript
      case "feedback.ack":
        if (frame.payload.ok) {
          this.callbacks.onFeedbackAck(
            frame.payload.target_id,
            frame.payload.feedback as "like" | "dislike",
          );
        }
        break;
```

**Step 5: Create `src/hooks/use-feedback.ts`**

```typescript
import { useCallback } from "react";
import { useStore, useAgentContext } from "../provider";
import type { FeedbackTarget } from "../types";

export function useFeedback(targetId: string, targetType: FeedbackTarget = "event") {
  const { client } = useAgentContext();

  const feedback = useStore((s) => s.feedback[targetId] ?? null);

  const like = useCallback(
    (reason?: string) => client.sendFeedback(targetType, targetId, "like", reason),
    [client, targetType, targetId],
  );

  const dislike = useCallback(
    (reason?: string) => client.sendFeedback(targetType, targetId, "dislike", reason),
    [client, targetType, targetId],
  );

  return { feedback, like, dislike };
}
```

**Step 6: Update `src/main.ts`**

Add:

```typescript
export { useFeedback } from "./hooks/use-feedback";
```

Add to type exports:

```typescript
export type { FeedbackType, FeedbackTarget } from "./types";
```

**Step 7: Verify**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 8: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/protocol/frames.ts src/types.ts src/store.ts src/client.ts src/hooks/use-feedback.ts src/main.ts
git commit -m "feat: add feedback module (types, frames, store, client, hook)"
```

---

### Task 8: Feedback Tests

**Files:**
- Modify: `tests/store.test.ts`
- Modify: `tests/client.test.ts`

**Step 1: Add store tests**

Add to `tests/store.test.ts`:

```typescript
  it("onFeedbackAck stores feedback by target ID", () => {
    const store = createAgentStore();
    store.getState().actions.onFeedbackAck("e1", "like");
    expect(store.getState().feedback.e1).toBe("like");
    store.getState().actions.onFeedbackAck("e1", "dislike");
    expect(store.getState().feedback.e1).toBe("dislike");
  });
```

**Step 2: Add client tests**

Update `createMockCallbacks` to include `onFeedbackAck: vi.fn()`.

Add to `tests/client.test.ts`:

```typescript
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
```

**Step 3: Run tests**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add tests/store.test.ts tests/client.test.ts
git commit -m "test: add feedback store and client tests"
```

---

### Task 9: Analytics — Types, Frames, Transforms

**Files:**
- Modify: `src/protocol/models.ts` (add WireAnalyticsEvent)
- Modify: `src/protocol/frames.ts` (add C2S + S2C frames)
- Modify: `src/types.ts` (add AnalyticsEvent + transform)

**Step 1: Add wire type to `src/protocol/models.ts`**

Append:

```typescript
// --- Analytics ---

export interface WireAnalyticsEvent {
  event: string;
  timestamp: string;
  agent_id: string;
  thread_id: string | null;
  user_id: string | null;
  run_id: string | null;
  event_id: string | null;
  data: Record<string, unknown> | null;
}
```

**Step 2: Add frames to `src/protocol/frames.ts`**

Add import for `WireAnalyticsEvent` from `./models`.

Add C2S:

```typescript
// --- Analytics C2S ---

export type C2S_AnalyticsSubscribe = Frame<"analytics.subscribe", { agent_id: string }>;

export type C2S_AnalyticsUnsubscribe = Frame<"analytics.unsubscribe", { agent_id: string }>;
```

Add S2C:

```typescript
// --- Analytics S2C ---

export type S2C_AnalyticsEvent = Frame<"analytics.event", WireAnalyticsEvent>;
```

Update `ClientToServer` union — add `C2S_AnalyticsSubscribe | C2S_AnalyticsUnsubscribe`.

Update `ServerToClient` union — add `S2C_AnalyticsEvent`.

**Step 3: Add public types and transform to `src/types.ts`**

Add import for `WireAnalyticsEvent`.

Add public type:

```typescript
// --- Analytics ---

export interface AnalyticsEvent {
  event: string;
  timestamp: string;
  agentId: string;
  threadId: string | null;
  userId: string | null;
  runId: string | null;
  eventId: string | null;
  data: Record<string, unknown> | null;
}
```

Add transform:

```typescript
export function toAnalyticsEvent(w: WireAnalyticsEvent): AnalyticsEvent {
  return {
    event: w.event,
    timestamp: w.timestamp,
    agentId: w.agent_id,
    threadId: w.thread_id,
    userId: w.user_id,
    runId: w.run_id,
    eventId: w.event_id,
    data: w.data,
  };
}
```

**Step 4: Verify**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/protocol/models.ts src/protocol/frames.ts src/types.ts
git commit -m "feat: add analytics wire types, frames, and transforms"
```

---

### Task 10: Analytics — Store, Client, Hook, Exports

**Files:**
- Modify: `src/store.ts`
- Modify: `src/client.ts`
- Create: `src/hooks/use-analytics.ts`
- Modify: `src/main.ts`

**Step 1: Add analytics store slice to `src/store.ts`**

Add import for `AnalyticsEvent`:

```typescript
import type { AnalyticsEvent, Run, SettingsItem, Thread, ThreadEvent } from "./types";
```

Add to `AgentState`:

```typescript
  analytics: {
    events: AnalyticsEvent[];
    counters: {
      totalRequests: number;
      feedbackLikes: number;
      feedbackDislikes: number;
    };
  };
```

Add to `AgentActions`:

```typescript
  onAnalyticsEvent: (event: AnalyticsEvent) => void;
  resetAnalytics: () => void;
```

Add initial state:

```typescript
    analytics: {
      events: [],
      counters: { totalRequests: 0, feedbackLikes: 0, feedbackDislikes: 0 },
    },
```

Add actions (ring buffer of 50 events, matching app-web pattern):

```typescript
      onAnalyticsEvent: (event) =>
        set((s) => {
          const events = [...s.analytics.events, event];
          const trimmed = events.length > 50 ? events.slice(-50) : events;
          const counters = { ...s.analytics.counters };
          if (event.event === "feedback.like") {
            counters.feedbackLikes += 1;
          } else if (event.event === "feedback.dislike") {
            counters.feedbackDislikes += 1;
          } else {
            counters.totalRequests += 1;
          }
          return { analytics: { events: trimmed, counters } };
        }),

      resetAnalytics: () =>
        set(() => ({
          analytics: {
            events: [],
            counters: { totalRequests: 0, feedbackLikes: 0, feedbackDislikes: 0 },
          },
        })),
```

**Step 2: Add client methods to `src/client.ts`**

Add import for `toAnalyticsEvent`:

```typescript
import {
  toAnalyticsEvent,
  toRun,
  toSettingsItem,
  toThread,
  toThreadEvent,
  toWireContentPart,
} from "./types";
```

Add public methods:

```typescript
  // --- Analytics ---

  subscribeAnalytics() {
    this.send("analytics.subscribe", { agent_id: this.agentId });
  }

  unsubscribeAnalytics() {
    this.send("analytics.unsubscribe", { agent_id: this.agentId });
  }
```

Add route case:

```typescript
      case "analytics.event":
        this.callbacks.onAnalyticsEvent(toAnalyticsEvent(frame.payload));
        break;
```

**Step 3: Create `src/hooks/use-analytics.ts`**

```typescript
import { useCallback } from "react";
import { useShallowStore, useAgentContext } from "../provider";

export function useAnalytics() {
  const { client } = useAgentContext();

  const events = useShallowStore((s) => s.analytics.events);
  const counters = useShallowStore((s) => s.analytics.counters);

  const subscribe = useCallback(() => client.subscribeAnalytics(), [client]);
  const unsubscribe = useCallback(() => client.unsubscribeAnalytics(), [client]);
  const reset = useCallback(() => {
    client.store?.getState().actions.resetAnalytics();
  }, [client]);

  return { events, counters, subscribe, unsubscribe, reset };
}
```

Wait — `client` doesn't expose store. Let me rethink. The hook should access the store action directly via context, not through client. Let me fix:

```typescript
import { useCallback } from "react";
import { useShallowStore, useStore, useAgentContext } from "../provider";

export function useAnalytics() {
  const { client, store } = useAgentContext();

  const events = useShallowStore((s) => s.analytics.events);
  const counters = useShallowStore((s) => s.analytics.counters);

  const subscribe = useCallback(() => client.subscribeAnalytics(), [client]);
  const unsubscribe = useCallback(() => client.unsubscribeAnalytics(), [client]);

  return { events, counters, subscribe, unsubscribe };
}
```

**Step 4: Update `src/main.ts`**

Add:

```typescript
export { useAnalytics } from "./hooks/use-analytics";
```

Add to type exports:

```typescript
export type { AnalyticsEvent } from "./types";
```

**Step 5: Verify**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/store.ts src/client.ts src/hooks/use-analytics.ts src/main.ts
git commit -m "feat: add analytics module (store, client, hook)"
```

---

### Task 11: Analytics Tests

**Files:**
- Modify: `tests/store.test.ts`
- Modify: `tests/client.test.ts`

**Step 1: Add store tests**

Add to `tests/store.test.ts`:

```typescript
  it("onAnalyticsEvent appends and increments counters", () => {
    const store = createAgentStore();
    store.getState().actions.onAnalyticsEvent({
      event: "message.c2s",
      timestamp: "2026-01-01T00:00:00Z",
      agentId: "w1",
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
    const store = createAgentStore();
    for (let i = 0; i < 55; i++) {
      store.getState().actions.onAnalyticsEvent({
        event: "message.c2s",
        timestamp: "2026-01-01T00:00:00Z",
        agentId: "w1",
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
    const store = createAgentStore();
    store.getState().actions.onAnalyticsEvent({
      event: "feedback.like",
      timestamp: "2026-01-01T00:00:00Z",
      agentId: "w1",
      threadId: null,
      userId: null,
      runId: null,
      eventId: null,
      data: null,
    });
    store.getState().actions.onAnalyticsEvent({
      event: "feedback.dislike",
      timestamp: "2026-01-01T00:00:00Z",
      agentId: "w1",
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
```

**Step 2: Add client tests**

Update `createMockCallbacks` to include `onAnalyticsEvent: vi.fn()` and `resetAnalytics: vi.fn()`.

Add to `tests/client.test.ts`:

```typescript
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
```

**Step 3: Run tests**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add tests/store.test.ts tests/client.test.ts
git commit -m "test: add analytics store and client tests"
```

---

### Task 12: Thread Pagination (Cursor + Load More)

Add cursor support to thread listing. This is something the raw client ignores entirely.

**Files:**
- Modify: `src/store.ts`
- Modify: `src/client.ts`
- Modify: `src/hooks/use-threads.ts`
- Modify: `tests/store.test.ts`

**Step 1: Add store state for pagination**

Add to `AgentState`:

```typescript
  threadListCursor: string | null;
  threadListHasMore: boolean;
```

Update `AgentActions.onThreadList` signature:

```typescript
  onThreadList: (threads: Thread[], cursor?: string | null) => void;
```

Add new action:

```typescript
  onThreadListAppend: (threads: Thread[], cursor?: string | null) => void;
```

Add initial state:

```typescript
    threadListCursor: null,
    threadListHasMore: false,
```

Update `onThreadList` implementation:

```typescript
      onThreadList: (threads, cursor) =>
        set(() => {
          const map: Record<string, Thread> = {};
          const order: string[] = [];
          for (const t of threads) {
            map[t.id] = t;
            order.push(t.id);
          }
          return {
            threads: map,
            threadOrder: order,
            threadListCursor: cursor ?? null,
            threadListHasMore: cursor != null,
          };
        }),
```

Add `onThreadListAppend`:

```typescript
      onThreadListAppend: (threads, cursor) =>
        set((s) => {
          const map = { ...s.threads };
          const order = [...s.threadOrder];
          for (const t of threads) {
            if (!map[t.id]) {
              order.push(t.id);
            }
            map[t.id] = t;
          }
          return {
            threads: map,
            threadOrder: order,
            threadListCursor: cursor ?? null,
            threadListHasMore: cursor != null,
          };
        }),
```

**Step 2: Update client to track load-more state**

In `src/client.ts`, add a private field:

```typescript
  private isLoadingMore = false;
```

Add a public method:

```typescript
  loadMoreThreads(limit?: number) {
    const cursor = this.lastThreadListCursor;
    if (!cursor) return;
    this.isLoadingMore = true;
    this.send("thread.list", { cursor, limit });
  }
```

Add another private field to track cursor:

```typescript
  private lastThreadListCursor: string | null = null;
```

Update the `thread.list.result` route case:

```typescript
      case "thread.list.result": {
        const threads = frame.payload.threads.map(toThread);
        const cursor = frame.payload.cursor ?? null;
        this.lastThreadListCursor = cursor;
        if (this.isLoadingMore) {
          this.callbacks.onThreadListAppend(threads, cursor);
        } else {
          this.callbacks.onThreadList(threads, cursor);
        }
        this.isLoadingMore = false;
        break;
      }
```

**Step 3: Update `src/hooks/use-threads.ts`**

```typescript
import { useCallback } from "react";
import { useShallowStore, useStore, useAgentContext } from "../provider";

export function useThreads() {
  const { client } = useAgentContext();

  const threads = useShallowStore((s) =>
    s.threadOrder.flatMap((id) => {
      const t = s.threads[id];
      return t ? [t] : [];
    }),
  );
  const isLoading = useStore((s) => s.connection.status !== "connected");
  const hasMore = useStore((s) => s.threadListHasMore);

  const deleteThread = useCallback((threadId: string) => client.deleteThread(threadId), [client]);
  const loadMore = useCallback((limit?: number) => client.loadMoreThreads(limit), [client]);

  return { threads, isLoading, hasMore, deleteThread, loadMore };
}
```

**Step 4: Add store tests**

Add to `tests/store.test.ts`:

```typescript
  it("onThreadList stores cursor and hasMore", () => {
    const store = createAgentStore();
    store.getState().actions.onThreadList(
      [thread("t1"), thread("t2")],
      "cursor-123",
    );
    expect(store.getState().threadListCursor).toBe("cursor-123");
    expect(store.getState().threadListHasMore).toBe(true);
  });

  it("onThreadListAppend adds threads without replacing", () => {
    const store = createAgentStore();
    store.getState().actions.onThreadList([thread("t1")]);
    store.getState().actions.onThreadListAppend([thread("t2")], null);
    expect(store.getState().threadOrder).toEqual(["t1", "t2"]);
    expect(store.getState().threadListHasMore).toBe(false);
  });
```

**Step 5: Run tests**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/store.ts src/client.ts src/hooks/use-threads.ts tests/store.test.ts
git commit -m "feat: add thread pagination with cursor and loadMore"
```

---

### Task 13: Per-Thread isWaiting Derived State

Add `isWaiting` to `ThreadState` so consumers don't need to manually derive it from runs.

**Files:**
- Modify: `src/types.ts` (update ThreadState)
- Modify: `src/hooks/use-thread.ts` (compute isWaiting)

**Step 1: Update ThreadState in `src/types.ts`**

```typescript
export interface ThreadState {
  thread: Thread | null;
  events: ThreadEvent[];
  runs: Run[];
  isLoading: boolean;
  isWaiting: boolean;
}
```

**Step 2: Update `src/hooks/use-thread.ts`**

Update `EMPTY_THREAD_STATE`:

```typescript
const EMPTY_THREAD_STATE: ThreadState = {
  thread: null,
  events: [],
  runs: [],
  isLoading: false,
  isWaiting: false,
};
```

Update the selector return:

```typescript
    const runs = s.runs[threadId] ?? [];

    return select({
      events: [...optimistic, ...confirmed],
      runs,
      thread: s.threads[threadId] ?? null,
      isLoading: s.loadingThreads.has(threadId),
      isWaiting: runs.some((r) => r.status === "running"),
    });
```

**Step 3: Verify**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/frndvrgs/software/dooers/dooers-teams
git add src/types.ts src/hooks/use-thread.ts
git commit -m "feat: add isWaiting derived state to ThreadState"
```

---

### Task 14: Final Verification

Run full checks to ensure everything is green.

**Step 1: TypeScript check**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsc --noEmit`
Expected: 0 errors

**Step 2: Lint**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx biome check .`
Expected: No errors (run `npx biome check --fix .` if import ordering issues)

**Step 3: Tests**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx vitest run`
Expected: All tests pass

**Step 4: Build**

Run: `cd /home/frndvrgs/software/dooers/dooers-teams && npx tsup`
Expected: Build succeeds, output in `dist/`

**Step 5: Server SDK check (no regressions)**

Run: `cd /home/frndvrgs/software/dooers/agents-server && uv run ruff check src/`
Expected: All checks passed

---

## Protocol Coverage After Plan

### C2S Frames (12/12)

| Frame | Status |
|-------|--------|
| `connect` | Task 1 (fix type) |
| `thread.list` | existing |
| `thread.subscribe` | existing |
| `thread.unsubscribe` | existing |
| `thread.delete` | existing |
| `event.create` | existing |
| `settings.subscribe` | Task 5 |
| `settings.unsubscribe` | Task 5 |
| `settings.patch` | Task 5 |
| `feedback` | Task 7 |
| `analytics.subscribe` | Task 10 |
| `analytics.unsubscribe` | Task 10 |

### S2C Frames (11/11)

| Frame | Status |
|-------|--------|
| `ack` | existing |
| `thread.list.result` | Task 12 (enhanced with cursor) |
| `thread.snapshot` | existing |
| `event.append` | existing |
| `thread.upsert` | existing |
| `thread.deleted` | existing |
| `run.upsert` | existing |
| `settings.snapshot` | Task 5 |
| `settings.patch` | Task 5 |
| `feedback.ack` | Task 7 |
| `analytics.event` | Task 10 |

### Improvements Over Raw Client

| Feature | Raw (app-web) | SDK (after plan) |
|---------|:------------:|:----------------:|
| Full protocol coverage | yes | yes |
| Normalized state (O(1) lookups) | no (arrays) | yes (records) |
| Refcounted subscriptions | no | yes |
| Precise optimistic reconciliation | no (heuristic) | yes (client_event_id) |
| Auto-resubscribe on reconnect | no | yes |
| Gap recovery (after_event_id) | no | yes |
| Thread pagination (cursor) | no | yes |
| Per-thread isWaiting | no (global) | yes |
| camelCase public API | no (snake_case) | yes |
| Multi-instance capable | no (singleton) | yes |
| Framework-agnostic client | no (React coupled) | yes |
| Type-safe transforms | no | yes |
