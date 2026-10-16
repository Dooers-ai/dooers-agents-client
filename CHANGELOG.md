# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.19.0] — 2026-10-16

### Added

- `getAuthToken` on `AgentProvider` (and `AgentConnectionConfig`). It is called
  before every socket and every `upload()`, so a reconnect never reuses an
  expired handshake token. A call that has not settled within 15 s fails like
  a throw. `authToken` still works when it is not set.
- Planned renewal of the connection. After 30 minutes with nothing pending and
  no run in progress (55 minutes at the latest, even while busy), the client
  opens a second socket with a fresh token and switches over only once its
  `connect` is acked. The old socket closes with code 1000. When the renewal
  succeeds the app sees no drop: the status stays `connected` and pending
  requests are not aborted, though a reply sent only to the old socket and
  still in transit at the swap can time out. A renewal that keeps failing
  falls back to a normal reconnect when the hosting cuts the socket at
  60 minutes. A redeployed agent is picked up within the hour. Thread list,
  thread and settings subscriptions and the analytics subscription are
  restored on the new socket.
- Resume on focus or network return. When the tab becomes visible again or the
  browser goes back `online`, a live socket is pinged and a lost one reconnects
  at once, without waiting for the backoff.
- Dead socket detection. A `ping` goes out every 30 s; a socket with no frame
  for 90 s is treated as dropped and reconnected. While a run is in progress or
  a request is pending the limit is 5 minutes, since the agent server does not
  answer pings while it runs a turn.

### Fixed

- The reconnect failure counter resets once a connection has stayed up for
  30 s. Long sessions with many hosting cuts no longer end in
  `reconnectFailed`, while a server that accepts the handshake and drops the
  socket at once still ends there after 5 tries. Backoff waits (1, 2, 4, 8,
  16 s) now carry ±20% jitter.
- `connect()` starts with a fresh retry budget, so switching to another
  runtime after giving up gets 5 attempts again.
- A rejected `connect` calls `onError` and tries again with a fresh token
  instead of stopping at status `error`, even when `onError` throws.
- A page request (`loadMore`) lost with a dropped socket no longer blocks the
  next one after reconnecting.

## [0.18.2] — 2026-10-13

### Fixed

- A `thread.list` snapshot no longer erases a thread that arrived via
  `thread.upsert` after that request was sent. The sidebar keeps new threads
  while the page stays open.
- Only one full list is in flight. A later queue filter replaces the in-flight
  snapshot instead of letting the slower response relabel the menu.

## [0.18.1] — 2026-10-13

### Fixed

- Live events and snapshot merges are placed by `createdAt` (then id). A queue
  move no longer leaves the timeline out of order until refresh.
- Unsubscribing keeps the last event cursor, so a resubscribe fills the gap
  instead of replaying the whole snapshot onto the tail.
- A `thread.upsert` that omits `access` no longer clears flags already received
  from list or snapshot.

## [0.18.0] — 2026-10-08

### Added

- Workspace **thread queues** (agents-server `>= 0.24.0`): optional `Thread.queue` slug.
- `requestThreadList(..., queue)` / `useThreadsActions().requestThreadList` — filter by slug.
- `UNQUEUED_QUEUE_FILTER` (`__none__`) lists threads with no queue.
- `updateThread(threadId, { queue })` / `useThreadsActions().updateThread` — `thread.update`.
- `sendMessage({ queue })` / `useMessage().send({ queue })` on new threads (`event.create`).
- `supportsThreadQueues(serverVersion)` — true for agents-server `>= 0.24.0`.

### Fixed

- Snapshot/upsert of the open thread no longer inserts it into the sidebar list when it does not match the active `thread.list` queue filter.

## [0.17.0] — 2026-09-11

### Added

- **`supportsThreadAccess(serverVersion)`** — true for agents-server `>= 0.22.0`.
- **`Thread.access`** (`read` / `write` / `manage`) on list/snapshot.
- **`subscribe(threadId, { accessReason })`** and `useThreadDetails` options `{ enabled, accessReason }`.
- **`addParticipant`** client helper for elevated join / handoff flows.
- **`setOnError`** surfaces `ACCESS_REASON_REQUIRED` from subscribe acks.

## [0.16.2] — 2026-08-31

### Added

- **`input_type: "date"`** on form `text_input` elements — native date picker; wire values are `YYYY-MM-DD`.

## [0.16.1] — 2026-08-18

### Fixed

- **`settings.public_schema.result`** reads ``payload.schema`` or ``payload.schema_`` so the chat model catalog works against agents-server 0.19.0.

### Added

- **`chatContext.reasoningEffort`** forwarded as ``chat_context.reasoning_effort``.

## [0.16.0] — 2026-08-18

### Added

- **`chatContext` on `sendMessage` / `useMessage().send()`.** Forwarded as ``event.create`` ``chat_context`` (currently ``llm_model``).
- **`supportsChatContext(serverVersion)`** — true for agents-server `>= 0.19.0`.
- **`LLM_MODELS_FIELD_ID`** — reserved settings field id (`llm_models`) for the chat model catalog.
- **`AgentClient.fetchPublicSettingsSchema()`** on an open session (same frame as `AgentServerClient`).

## [0.11.0] — 2026-06-18

### Changed

- **BREAKING — package rename.** The npm package is renamed back to **`dooers-agents-client`** (from `dooers-agents`). Update imports: `from "dooers-agents"` → `from "dooers-agents-client"`. The Connect handshake `client.name` identifier is `dooers-agents-client` again.

## [0.10.1] — 2026-06-18

### Added

- **`AgentClient.updateConnectionConfig()`** — refresh handshake token and identity metadata without tearing down the WebSocket.
- **Settings subscription restore** — active `settings.subscribe` is re-sent after reconnect (same pattern as thread subscriptions).
- **WebSocket heartbeat** — client sends `ping` every 30s while connected.

### Changed

- **`AgentProvider`** — hard reconnect only when `url` or `agentId` changes; `authToken` and role fields hot-update via `updateConnectionConfig`.

## [0.10.0] — 2026-06-17

### Changed

- **BREAKING — package rename.** The npm package is renamed **`dooers-agents-client` → `dooers-agents`**. Update imports: `import { ... } from "dooers-agents-client"` → `from "dooers-agents"`. The Connect handshake `client.name` identifier is now `dooers-agents`. The public API is otherwise unchanged. Previously published versions remain available on npm under the old `dooers-agents-client` name; new releases publish as `dooers-agents`.

## [0.9.3] — 2026-05-13

### Added

- **Channel metadata on `event.create`:** `AgentClient.sendMessage()` and `useMessage().send()` accept optional **`channel`** and **`channelMeta`** params, forwarded into the `event.create` payload so external channels (e.g. WhatsApp) can persist routing and audit metadata. Provider/config typing is exposed for typed integrations.
- **`ref_id` on S2C display parts:** server-to-client audio, image, and document parts now carry an optional **`refId`** mapped from the wire **`ref_id`**, matching `dooers-agents-server` parity.
- **Handshake `client.version`:** the connect frame now reports `client.version` from **`PACKAGE_VERSION`** (also re-exported from the package entrypoint) so server-side analytics can correlate connections to a specific SDK build.

## [0.9.2] — 2026-05-12

### Fixed

- **Durable chat attachments:** `toWireContentPart` now forwards optional **`filename`** and **`mime_type`** for audio, image, and document parts so the server can rebuild the same blob object key as `POST /uploads` (previously document/image sends without filename defaulted the key segment to `file` / `image`, so GCS/Azure resolution failed with `UPLOAD_NOT_FOUND`).
- **`event.create` ack errors:** the outbound frame **`id`** for `sendMessage` / `sendFormResponse` is now the same as **`client_event_id`**, matching the server `ack_id`, so failed acks **reject** the returned promise, **roll back** the optimistic thread event, and set **`connection.sendError`** for UI banners.
- **HTTP upload errors:** `AgentClient.upload()` surfaces FastAPI **`detail`** text when `POST /uploads` returns an error body.
- **Voice / `Blob` uploads:** `FormData` now sets an explicit multipart filename for **`Blob`** bodies (and optional `upload(file, { filename })`), matching the server’s stored object key; voice messages no longer send a mismatched display-only filename on the WebSocket.
- **Reconnect:** pending sends are aborted when the socket is replaced or when reconnection is given up, instead of hanging until timeout.

### Added

- **`connection.sendError`** and **`useConnection().dismissSendError`**, plus **`AgentClient.clearSendError()`**, for surfacing the last send/attachment rejection without treating the whole socket as disconnected.

## [0.9.0] — 2026-04-17

Client-side mirror of the `dooers-agents-server` 0.9.0 release. Additive
on top of 0.8.0 — no breaking changes.

### Added

- **`metadata` on `event.create`.** `AgentClient.sendMessage()` and
  `useMessage().send()` accept an optional `metadata?: Record<string, unknown>`
  param that is forwarded in the `event.create` frame payload. The server
  persists it on thread creation only (ignored on subsequent messages to
  the same thread), so callers can attach per-thread context — pre-chat
  form values, routing hints, external IDs — without polluting the user
  identity fields.
- **`Thread.metadata`** on the wire type and high-level `Thread` type.
  Callers reading a thread through `useThreadDetails()` can surface the
  stored metadata in the UI.

### Compatibility

Fully additive. Existing `send({ text })` / `send({ content })` callers
work unchanged. The metadata field is optional everywhere.

## [0.8.0] — 2026-04-14

Client-side mirror of the `dooers-agents-server` 0.8.0 upload-URL feature.
Fully additive on top of 0.6.0 — no breaking changes. The version jumps
straight from 0.6.0 to 0.8.0 to stay in sync with the server release,
which went `0.6.0 → 0.7.0 → 0.8.0` over the same period. **There is no
client-side `0.7.0` release**; the client had no changes during the
server's 0.7.0 public-chat-webhook work.

### Added

- **Upload URL propagation on content parts.** `WireC2S_AudioPart`,
  `WireC2S_ImagePart`, and `WireC2S_DocumentPart` gain an optional
  `url?: string | null` field. `AudioSendPart`, `ImageSendPart`, and
  `DocumentSendPart` (the high-level handler-facing types) gain an
  optional `url?: string` field. The `toWireContentPart` converter
  propagates the `url` field from the high-level type to the wire type.
- **`UploadResult.publicUrl`** — the result returned by
  `AgentClient.uploadFile()` now carries an optional
  `publicUrl?: string | null` field. When the server's upload endpoint
  responds with a `public_url` (e.g. because the agent persisted the
  file to an object store), the client surfaces it here so callers can
  reuse the URL on subsequent messages instead of re-uploading.
- **`agent_id` in the upload form-data.** `AgentClient.uploadFile()`
  now includes `agent_id` in the multipart body when `this.agentId` is
  set, so the server can scope/process the upload per agent.
- **Backwards-compatible response parsing.** The upload response
  handler now reads `size_bytes` with a fallback to `size`, and reads
  `public_url` with a fallback to `undefined`, so the client works
  against both old and new server response shapes.

### Compatibility

- **Wire protocol**: all new fields are optional. A 0.8.0 client can
  talk to a 0.6.0 or 0.7.0 server (the new `url` field will simply be
  missing from the frames it sends). A 0.6.0 client can talk to a
  0.8.0 server (the new fields are optional and will be unset).
- **Handler API**: additive only. Existing handlers that don't read
  `url` continue to work unchanged.
- **Peer deps**: unchanged (`react ^18 || ^19`).
- **Runtime deps**: unchanged (`zustand ^5`).

### Why 0.8.0 and not 0.7.0

The `dooers-agents-server` SDK ran ahead of the client during the
external-chat / public-chat work:

- `dooers-agents-server 0.7.0` shipped the public-chat webhook delegation
  and guest-thread cleanup. That was a server-only release — no client
  changes were needed.
- `dooers-agents-server 0.8.0` shipped the upload-URL work that has a
  matching client-side piece (this release).

Rather than ship client `0.7.0` with no content and then `0.8.0` with
the upload URL content, we skip `0.7.0` entirely on the client and
bump straight to `0.8.0`. Consumers now get matching versions:
"`dooers-agents-server 0.8.0`" + "`dooers-agents-client 0.8.0`".

### Upgrade notes

```bash
npm install dooers-agents-client@0.8.0
# or
pnpm add dooers-agents-client@0.8.0
```

No code changes required. To consume the new `publicUrl` when uploading:

```ts
const result = await agentClient.uploadFile(file)
if (result.publicUrl) {
  // persisted attachment — reuse publicUrl in later messages
} else {
  // ephemeral — use refId as today
}
```

To send a content part with a URL (rarely needed directly; usually
passed through from an upload result):

```ts
const part: ImageSendPart = {
  type: 'image',
  refId: uploadResult.refId,
  url: uploadResult.publicUrl ?? undefined,
}
```
