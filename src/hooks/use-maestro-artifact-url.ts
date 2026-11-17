import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MAESTRO_VIEW_TYPE,
  type MaestroArtifactResource,
  type MaestroArtifacts,
  maestroBlobType,
} from '../maestro/artifacts'
import type { MaestroClient } from '../maestro/client'
import { MAESTRO_SUPERVISION_READ_ONLY, MaestroClientError } from '../maestro/types'
import { MaestroAgentClient } from '../maestro-agent-client'
import { useAgentContext } from '../provider'

/** Attachment part of a message as the chat components receive it (image, audio or document). */
export interface MaestroArtifactPart {
  refId?: string
  mimeType?: string
  filename?: string
  size?: number
  /** Same meaning as `size`; accepted so a display part can be passed as it is. */
  sizeBytes?: number
  /** A part that already has a URL (legacy agents) is not opened here. */
  url?: string | null
}

export interface UseMaestroArtifactUrlOptions {
  /**
   * Whether the media is on screen. Hidden media does not open, and its resource is the first
   * one released when the client needs a slot. Default: `true`.
   */
  visible?: boolean
  /**
   * Keeps one URL for as long as the component is mounted: no renewal, no release when off
   * screen, no eviction. After the read the hook copies the file to its own `blob:` URL and
   * releases the artifact resource at once, so the resource leaves the 8-live limit. Use it for
   * media that must not be cut while playing (audio); the copy lives in memory until unmount.
   * The copy reads the `blob:` URL with `fetch`, so the page `connect-src` must allow `blob:`.
   * Default: `false`.
   */
  stable?: boolean
}

export interface MaestroArtifactUrlResult {
  url: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorCode?: string
  /**
   * `MAESTRO_SUPERVISION_READ_ONLY` when the thread is read by supervision: the file is not opened
   * (no request) and there is no `viewLink`. Supervision only reads; the person joins the
   * conversation to open, download or view the file. `errorCode` is then `FORBIDDEN`.
   */
  reasonCode?: string
  /**
   * I1: only for a file of type `application/pdf`. Asks the Maestro for the short-lived view link of
   * the PDF (served `inline` from the Maestro origin, never from the app origin). The View panel opens
   * this link; `url` (a `blob:` of type `application/octet-stream`) only downloads the file.
   */
  viewLink?: (signal?: AbortSignal) => Promise<string>
}

const MAX_READS = 2
/**
 * Reads of large files at the same time. A large file never takes the last read slot: the chips and
 * thumbnails of small files, in this thread or another one, keep opening while a 25 MiB file
 * downloads. A part without a size (it does not happen with Maestro attachments) counts as small.
 */
const MAX_LARGE_READS = 1
/** From this size a read is large (`MAX_LARGE_READS`). */
export const MAESTRO_LARGE_READ_BYTES = 4 * 1024 * 1024
const MAX_LIVE = 8
const RETRY_DELAYS_MS = [1000, 2000, 4000]
/** The host revokes a resource 60 s after the read; renew before that. */
const RENEW_BEFORE_EXPIRY_MS = 10_000
const DROP_BEFORE_EXPIRY_MS = 1000
/** Upper bound to keep a superseded resource when the consumer does not re-render. */
const SUPERSEDED_RELEASE_MS = 5000

interface Snapshot {
  url: string | null
  status: MaestroArtifactUrlResult['status']
  errorCode?: string
}
const IDLE: MaestroArtifactUrlResult = Object.freeze({ url: null, status: 'idle' })
const SUPERVISED: MaestroArtifactUrlResult = Object.freeze({
  url: null,
  status: 'error',
  errorCode: 'FORBIDDEN',
  reasonCode: MAESTRO_SUPERVISION_READ_ONLY,
})

interface EntryInit {
  threadId: string
  refId: string
  mimeType?: string
  filename?: string
  size?: number
  visible: boolean
  stable: boolean
}

class Entry {
  resource: MaestroArtifactResource | null = null
  /** The thread history in the client cites the file (checked again when a read is refused). */
  cited = false
  acquiredSeq = 0
  waitSeq = 0
  visible: boolean
  inflight: AbortController | null = null
  /** Signal of the latest read; aborted on dispose even after the read finished. */
  controller: AbortController | null = null
  backoff: ReturnType<typeof setTimeout> | null = null
  renewalDue = false
  attempts = 0
  errorCode: string | null = null
  disposed = false
  renewTimer: ReturnType<typeof setTimeout> | null = null
  dropTimer: ReturnType<typeof setTimeout> | null = null
  /** Superseded resources kept alive until the consumer shows the new URL. */
  superseded: MaestroArtifactResource[] = []
  supersededTimer: ReturnType<typeof setTimeout> | null = null
  private last: Snapshot | null = null

  constructor(
    readonly init: EntryInit,
    private readonly listener: (snapshot: Snapshot) => void
  ) {
    this.visible = init.visible
  }

  snapshot(): Snapshot {
    if (this.errorCode) return { url: null, status: 'error', errorCode: this.errorCode }
    if (this.resource) return { url: this.resource.url, status: 'ready' }
    return { url: null, status: this.visible ? 'loading' : 'idle' }
  }

  emit() {
    if (this.disposed) return
    const next = this.snapshot()
    const last = this.last
    if (
      last &&
      last.url === next.url &&
      last.status === next.status &&
      last.errorCode === next.errorCode
    )
      return
    this.last = next
    this.listener(next)
  }

  /** A large file: it waits for the large-read slot (`MAX_LARGE_READS`). */
  get large() {
    return this.init.size !== undefined && this.init.size >= MAESTRO_LARGE_READ_BYTES
  }

  /** Wants a read: on screen and either has no resource or must renew it. */
  get wantsRead() {
    return (
      !this.disposed &&
      this.visible &&
      !this.inflight &&
      !this.backoff &&
      !this.errorCode &&
      (!this.resource || this.renewalDue)
    )
  }
}

/** What the queue reads from the Maestro client besides `artifacts`. */
type MaestroHistory = Pick<MaestroClient, 'citesArtifact'> & {
  store: { subscribe(listener: () => void): () => void }
}

/**
 * Per-client queue: at most 2 reads at the same time (only 1 of a large file) and 8 live resources.
 * A resource that is off screen is released (oldest first) when a visible one needs the slot.
 *
 * A file opens only when the thread history in the client cites it. The message the person is
 * sending shows before the server event arrives; the client refuses to read its file until then.
 * The entry waits in `loading` and opens when the store brings the event.
 */
class ArtifactQueue {
  private entries = new Set<Entry>()
  private reads = 0
  private largeReads = 0
  private seq = 0
  private unwatch: (() => void) | null = null

  constructor(
    private readonly artifacts: MaestroArtifacts,
    private readonly history: MaestroHistory
  ) {}

  add(init: EntryInit, listener: (snapshot: Snapshot) => void): Entry {
    const entry = new Entry(init, listener)
    entry.waitSeq = ++this.seq
    this.entries.add(entry)
    entry.emit()
    this.pump()
    return entry
  }

  setVisible(entry: Entry, visible: boolean) {
    if (entry.disposed || entry.visible === visible) return
    entry.visible = visible
    if (visible) entry.waitSeq = ++this.seq
    entry.emit()
    this.pump()
  }

  dispose(entry: Entry) {
    if (entry.disposed) return
    entry.disposed = true
    this.entries.delete(entry)
    if (entry.backoff) clearTimeout(entry.backoff)
    if (entry.renewTimer) clearTimeout(entry.renewTimer)
    if (entry.dropTimer) clearTimeout(entry.dropTimer)
    entry.backoff = entry.renewTimer = entry.dropTimer = null
    entry.inflight?.abort()
    entry.controller?.abort()
    const resource = entry.resource
    entry.resource = null
    resource?.release()
    this.releaseSuperseded(entry)
    this.pump()
  }

  /** The consumer rendered the current URL: the previous resources can be revoked now. */
  releaseSuperseded(entry: Entry) {
    if (entry.supersededTimer) clearTimeout(entry.supersededTimer)
    entry.supersededTimer = null
    const old = entry.superseded
    entry.superseded = []
    for (const resource of old) resource.release()
  }

  private liveCount() {
    let live = 0
    for (const entry of this.entries) {
      if (entry.resource && !entry.init.stable) live++
      if (entry.inflight) live++
    }
    return live
  }

  private isCited(entry: Entry) {
    if (!entry.cited)
      entry.cited = this.history.citesArtifact(entry.init.threadId, entry.init.refId)
    return entry.cited
  }

  /** Listens to the store only while an entry waits for the event that cites its file. */
  private watch() {
    let waiting = false
    for (const entry of this.entries)
      if (entry.wantsRead && !entry.cited) {
        waiting = true
        break
      }
    if (waiting && !this.unwatch) this.unwatch = this.history.store.subscribe(() => this.pump())
    else if (!waiting && this.unwatch) {
      this.unwatch()
      this.unwatch = null
    }
  }

  private next(): Entry | undefined {
    let best: Entry | undefined
    for (const entry of this.entries) {
      if (!entry.wantsRead || !this.isCited(entry)) continue
      if (entry.large && this.largeReads >= MAX_LARGE_READS) continue
      if (
        !best ||
        (entry.renewalDue && !best.renewalDue) ||
        (entry.renewalDue === best.renewalDue && entry.waitSeq < best.waitSeq)
      )
        best = entry
    }
    return best
  }

  /** Releases the oldest resource that is off screen. */
  private evictOne(): boolean {
    let oldest: Entry | undefined
    for (const entry of this.entries) {
      if (!entry.resource || entry.init.stable || entry.visible || entry.inflight) continue
      if (!oldest || entry.acquiredSeq < oldest.acquiredSeq) oldest = entry
    }
    if (!oldest) return false
    this.drop(oldest)
    return true
  }

  private drop(entry: Entry) {
    if (entry.renewTimer) clearTimeout(entry.renewTimer)
    if (entry.dropTimer) clearTimeout(entry.dropTimer)
    entry.renewTimer = entry.dropTimer = null
    entry.renewalDue = false
    const resource = entry.resource
    entry.resource = null
    resource?.release()
    this.releaseSuperseded(entry)
    entry.emit()
  }

  pump() {
    while (this.reads < MAX_READS) {
      const entry = this.next()
      if (!entry) break
      if (this.liveCount() >= MAX_LIVE && !this.evictOne()) break
      this.start(entry)
    }
    this.watch()
  }

  private start(entry: Entry) {
    const controller = new AbortController()
    entry.inflight = controller
    entry.controller = controller
    this.reads++
    // M7: a due renewal of a URL on screen checks the access with a 1-byte read and keeps the same
    // URL and bytes (`MaestroArtifacts.renew`); the file is not downloaded again. It is never large.
    const renewing = entry.renewalDue && entry.resource !== null && !entry.init.stable
    const large = entry.large && !renewing
    if (large) this.largeReads++
    const { threadId, refId, mimeType, filename, size } = entry.init
    const attachment = {
      type: 'attachment' as const,
      artifact_id: refId,
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mime_type: mimeType } : {}),
      ...(size !== undefined ? { size_bytes: size } : {}),
    }
    let opening: Promise<MaestroArtifactResource>
    try {
      if (renewing && entry.resource)
        opening = this.artifacts.renew(entry.resource, controller.signal)
      else {
        opening = this.artifacts.open(threadId, attachment, controller.signal)
        if (entry.init.stable)
          opening = opening.then((resource) => copyToOwnBlob(resource, controller.signal))
      }
    } catch (cause) {
      opening = Promise.reject(cause)
    }
    opening.then(
      (resource) => {
        this.reads--
        if (large) this.largeReads--
        entry.inflight = null
        if (entry.disposed || controller.signal.aborted) resource.release()
        else this.accept(entry, resource)
        this.pump()
      },
      (cause) => {
        this.reads--
        if (large) this.largeReads--
        entry.inflight = null
        if (!entry.disposed && !controller.signal.aborted) this.fail(entry, cause)
        this.pump()
      }
    )
  }

  private accept(entry: Entry, resource: MaestroArtifactResource) {
    const previous = entry.resource
    entry.resource = resource
    entry.acquiredSeq = ++this.seq
    entry.renewalDue = false
    entry.attempts = 0
    if (entry.renewTimer) clearTimeout(entry.renewTimer)
    if (entry.dropTimer) clearTimeout(entry.dropTimer)
    if (entry.init.stable) {
      entry.emit()
      return
    }
    const remaining = Math.max(0, resource.expiresAt - Date.now())
    entry.renewTimer = setTimeout(
      () => {
        entry.renewTimer = null
        if (entry.disposed) return
        entry.renewalDue = true
        this.pump()
      },
      Math.max(0, remaining - RENEW_BEFORE_EXPIRY_MS)
    )
    // A resource that could not be renewed in time is dropped before the host revokes it.
    entry.dropTimer = setTimeout(
      () => {
        entry.dropTimer = null
        if (entry.disposed || entry.resource !== resource) return
        this.drop(entry)
        this.pump()
      },
      Math.max(0, remaining - DROP_BEFORE_EXPIRY_MS)
    )
    entry.emit()
    // Revoke the old URL only after the consumer swapped to the new one, so that an `<audio>`
    // that is playing is not cut. The timer is a bound for a consumer that never re-renders.
    if (previous) {
      entry.superseded.push(previous)
      if (!entry.supersededTimer)
        entry.supersededTimer = setTimeout(() => {
          entry.supersededTimer = null
          this.releaseSuperseded(entry)
        }, SUPERSEDED_RELEASE_MS)
    }
  }

  private fail(entry: Entry, cause: unknown) {
    const code = cause instanceof MaestroClientError ? cause.code : 'INVALID_REFERENCE'
    if (
      code === 'FORBIDDEN' &&
      !this.history.citesArtifact(entry.init.threadId, entry.init.refId)
    ) {
      // The history no longer cites the file (it is being reloaded): wait for it, not an error.
      entry.cited = false
      entry.renewalDue = false
      return
    }
    if (code === 'RATE_LIMITED' && entry.attempts < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[entry.attempts]!
      entry.attempts++
      entry.backoff = setTimeout(() => {
        entry.backoff = null
        this.pump()
      }, delay)
      return
    }
    if (entry.resource) {
      // A failed renewal keeps the current URL until it is dropped, then the entry reloads (a full
      // read, which shows the real error if the access is gone).
      entry.renewalDue = false
      return
    }
    entry.errorCode = code
    entry.emit()
  }
}

/**
 * Copies the artifact resource to a `blob:` URL owned by the hook and releases the resource.
 * The copy has no expiry; its `release` revokes the URL.
 */
async function copyToOwnBlob(
  resource: MaestroArtifactResource,
  signal: AbortSignal
): Promise<MaestroArtifactResource> {
  try {
    const response = await fetch(resource.url, { signal })
    const copy = await response.blob()
    // Same rule as `MaestroArtifacts.open`: only inline media keep their real type.
    const blob = new Blob([copy], { type: maestroBlobType(resource.mimeType) })
    signal.throwIfAborted()
    const url = URL.createObjectURL(blob)
    let revoked = false
    return {
      url,
      mimeType: resource.mimeType,
      filename: resource.filename,
      expiresAt: Number.POSITIVE_INFINITY,
      release: () => {
        if (revoked) return
        revoked = true
        URL.revokeObjectURL(url)
      },
    }
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new MaestroClientError('NETWORK_ERROR', 'Could not copy the artifact', true)
  } finally {
    resource.release()
  }
}

const queues = new WeakMap<MaestroArtifacts, ArtifactQueue>()
function queueFor(artifacts: MaestroArtifacts, history: MaestroHistory): ArtifactQueue {
  let queue = queues.get(artifacts)
  if (!queue) {
    queue = new ArtifactQueue(artifacts, history)
    queues.set(artifacts, queue)
  }
  return queue
}

/**
 * Turns a Maestro attachment (`refId` = artifact id) into a short-lived `blob:` URL through the
 * authenticated download. Only a Maestro client with a part that has `refId` and no `url` opens
 * anything; any other case returns `{ url: null, status: 'idle' }`.
 *
 * The URL expires in about 60 s: the hook renews it while the component is mounted (a 1-byte
 * access check that keeps the same URL; the file is downloaded once), and aborts the read and
 * releases the resource on unmount or when the thread or part changes.
 *
 * A part whose file the thread history does not cite yet (the message the person is sending,
 * shown before the server event) stays `loading` and opens when the event arrives.
 */
export function useMaestroArtifactUrl(
  threadId: string | undefined | null,
  part: MaestroArtifactPart | undefined,
  options?: UseMaestroArtifactUrlOptions
): MaestroArtifactUrlResult {
  const { client } = useAgentContext()
  const maestro = client instanceof MaestroAgentClient ? client.getMaestroClient() : null
  const artifacts = maestro?.artifacts ?? null
  const refId = part?.refId
  const mimeType = part?.mimeType
  const filename = part?.filename
  const size = part?.size ?? part?.sizeBytes
  const hasUrl = Boolean(part?.url)
  const visible = options?.visible ?? true
  const stable = options?.stable ?? false
  // Supervision only reads (SEC-03): its files are neither opened nor viewed.
  const supervised = Boolean(maestro && threadId && maestro.isSupervision(threadId))
  const eligible = Boolean(artifacts && threadId && refId && !hasUrl && !supervised)
  const identity = `${threadId}|${refId}|${mimeType}|${filename}|${size}`

  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const entryRef = useRef<{ entry: Entry; queue: ArtifactQueue } | null>(null)
  const [state, setState] = useState<{
    artifacts: MaestroArtifacts | null
    identity: string
    snapshot: Snapshot
  } | null>(null)

  useEffect(() => {
    if (!maestro || !artifacts || !threadId || !refId || hasUrl || supervised) return
    const queue = queueFor(artifacts, maestro)
    const entry = queue.add(
      { threadId, refId, mimeType, filename, size, visible: visibleRef.current, stable },
      (snapshot) => setState({ artifacts, identity, snapshot })
    )
    entryRef.current = { entry, queue }
    return () => {
      entryRef.current = null
      queue.dispose(entry)
    }
  }, [
    maestro,
    artifacts,
    threadId,
    refId,
    mimeType,
    filename,
    size,
    hasUrl,
    identity,
    stable,
    supervised,
  ])

  useEffect(() => {
    entryRef.current?.queue.setVisible(entryRef.current.entry, visible)
  }, [visible])

  const current =
    state && state.artifacts === artifacts && state.identity === identity ? state.snapshot : null
  const url = current?.url ?? null
  const status = eligible ? (current?.status ?? (visible ? 'loading' : 'idle')) : 'idle'
  const errorCode = current?.errorCode

  // Runs after the commit that shows `url`: the previous URL is no longer in the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `url` is the trigger.
  useEffect(() => {
    const live = entryRef.current
    if (live) live.queue.releaseSuperseded(live.entry)
  }, [url])

  const viewable = mimeType?.split(';')[0]?.trim().toLowerCase() === MAESTRO_VIEW_TYPE
  const viewLink = useMemo(
    () =>
      eligible && viewable && artifacts && threadId && refId
        ? (signal?: AbortSignal) =>
            artifacts
              .viewLink(
                threadId,
                {
                  type: 'attachment',
                  artifact_id: refId,
                  ...(filename ? { filename } : {}),
                  ...(mimeType ? { mime_type: mimeType } : {}),
                  ...(size !== undefined ? { size_bytes: size } : {}),
                },
                signal
              )
              .then((link) => link.url)
        : undefined,
    [eligible, viewable, artifacts, threadId, refId, filename, mimeType, size]
  )

  return useMemo(() => {
    if (supervised && refId && !hasUrl) return SUPERVISED
    if (!eligible) return IDLE
    const base =
      errorCode && status === 'error' ? { url: null, status, errorCode } : { url, status }
    return viewLink ? { ...base, viewLink } : base
  }, [supervised, refId, hasUrl, eligible, url, status, errorCode, viewLink])
}
