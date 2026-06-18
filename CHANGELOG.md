# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
