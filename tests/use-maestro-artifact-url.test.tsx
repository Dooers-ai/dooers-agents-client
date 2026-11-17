import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentClient } from '../src/client'
import { useMaestroArtifactUrl } from '../src/hooks/use-maestro-artifact-url'
import { MaestroAgentClient } from '../src/maestro-agent-client'
import { MaestroClientError } from '../src/maestro/types'
import { event, make, thread, threadId as FIXTURE_THREAD, tick, uuid } from './fixtures/maestro-replay'

const holder = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../src/provider', () => ({ useAgentContext: () => ({ client: holder.client }) }))

const T1 = '00000000-0000-4000-8000-000000000003'
const T2 = '00000000-0000-4000-8000-000000000004'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

interface FakeOptions {
  /** Time (ms) a read takes. */
  readMs?: number
  /** Time (ms) the read of one artifact takes (overrides `readMs`). */
  readMsFor?: (artifactId: string) => number | undefined
  /** Called before the host-like checks; may throw to simulate a failure. */
  before?: (call: number, artifactId: string) => void
  /** When true the fake ignores the abort signal (a read that finishes after abort). */
  ignoreAbort?: boolean
  /** MIME type of the fake resource. Default: image/png. */
  mimeType?: string
}

/** Fake `artifacts.open` that enforces the same limits as the real host (2 reads, 8 live). */
function fakeArtifacts(options: FakeOptions = {}) {
  const state = {
    reads: 0,
    live: 0,
    maxReads: 0,
    maxLive: 0,
    calls: [] as { at: number; threadId: string; artifactId: string; signal?: AbortSignal }[],
    rateLimited: 0,
    resources: [] as { url: string; artifactId: string; release: ReturnType<typeof vi.fn>; released: boolean }[],
  }
  const open = vi.fn(async (threadId: string, attachment: { artifact_id: string }, signal?: AbortSignal) => {
    state.calls.push({ at: Date.now(), threadId, artifactId: attachment.artifact_id, signal })
    options.before?.(state.calls.length, attachment.artifact_id)
    if (state.reads >= 2 || state.live >= 8) {
      state.rateLimited++
      throw new MaestroClientError('RATE_LIMITED', 'Artifact request unavailable', true)
    }
    state.reads++
    state.maxReads = Math.max(state.maxReads, state.reads)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          resolve,
          options.readMsFor?.(attachment.artifact_id) ?? options.readMs ?? 10
        )
        if (!options.ignoreAbort)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new MaestroClientError('DISCONNECTED', 'aborted'))
          })
      })
    } finally {
      state.reads--
    }
    state.live++
    state.maxLive = Math.max(state.maxLive, state.live)
    const entry = {
      url: `blob:${attachment.artifact_id}#${state.calls.length}`,
      artifactId: attachment.artifact_id,
      released: false,
      release: vi.fn(),
    }
    entry.release.mockImplementation(() => {
      if (entry.released) return
      entry.released = true
      state.live--
    })
    state.resources.push(entry)
    return {
      url: entry.url,
      mimeType: options.mimeType ?? 'image/png',
      filename: 'a.png',
      expiresAt: Date.now() + 60000,
      release: entry.release,
    }
  })
  return { state, open }
}

/**
 * Fake Maestro history: which artifacts the thread events cite. Default: every artifact, like a
 * thread whose events are all loaded. `cite` marks one more and notifies like the real store.
 */
function fakeHistory(citesAll = true) {
  const cited = new Set<string>()
  const listeners = new Set<() => void>()
  return {
    citesArtifact: (threadId: string, artifactId: string) =>
      citesAll || cited.has(`${threadId}|${artifactId}`),
    store: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    listeners,
    cite(threadId: string, artifactId: string) {
      cited.add(`${threadId}|${artifactId}`)
      for (const listener of [...listeners]) listener()
    },
  }
}

function useFakeMaestro(fake: ReturnType<typeof fakeArtifacts>, history = fakeHistory()) {
  const client = Object.create(MaestroAgentClient.prototype) as MaestroAgentClient
  // stable, like the real client
  const maestro = { artifacts: { open: fake.open }, citesArtifact: history.citesArtifact, store: history.store }
  client.getMaestroClient = (() => maestro) as never
  holder.client = client
  return history
}

interface ItemProps {
  name: string
  threadId?: string
  refId?: string
  url?: string
  visible?: boolean
  stable?: boolean
  sizeBytes?: number
}
function Item({ name, threadId = T1, refId, url, visible, stable, sizeBytes }: ItemProps) {
  const result = useMaestroArtifactUrl(
    threadId,
    { refId, url, mimeType: 'image/png', filename: 'a.png', ...(sizeBytes === undefined ? {} : { sizeBytes }) },
    visible === undefined && stable === undefined
      ? undefined
      : { ...(visible === undefined ? {} : { visible }), ...(stable === undefined ? {} : { stable }) }
  )
  return (
    <div data-testid={name} data-status={result.status} data-code={result.errorCode ?? ''}>
      {result.url ?? ''}
    </div>
  )
}
const snap = (view: { getByTestId: (id: string) => HTMLElement }, name: string) => {
  const el = view.getByTestId(name)
  return { status: el.dataset.status, url: el.textContent, code: el.dataset.code }
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  holder.client = null
})

describe('useMaestroArtifactUrl', () => {
  it('12 imagens ficam prontas sem erro (nunca mais de 8 vivos e 2 abrindo)', async () => {
    const fake = fakeArtifacts()
    useFakeMaestro(fake)
    const images = Array.from({ length: 12 }, (_, i) => i)
    const list = (start: number) => (
      <>
        {images.map((i) => (
          <Item key={i} name={`img${i}`} refId={id(100 + i)} visible={i >= start && i < start + 8} />
        ))}
      </>
    )
    const view = render(list(0))
    await advance(2000)
    for (let i = 0; i < 8; i++) expect(snap(view, `img${i}`).status).toBe('ready')
    for (let i = 8; i < 12; i++) expect(snap(view, `img${i}`).status).toBe('idle')
    // The window scrolls: the oldest resources outside the screen are released first.
    view.rerender(list(4))
    await advance(2000)
    for (let i = 4; i < 12; i++) expect(snap(view, `img${i}`)).toMatchObject({ status: 'ready' })
    for (let i = 0; i < 4; i++) expect(snap(view, `img${i}`)).toMatchObject({ status: 'idle', url: '' })
    expect(fake.state.resources.filter((r) => r.released).map((r) => r.artifactId)).toEqual(
      [0, 1, 2, 3].map((i) => id(100 + i))
    )
    view.rerender(list(0))
    await advance(2000)
    for (let i = 0; i < 8; i++) expect(snap(view, `img${i}`).status).toBe('ready')
    expect(fake.state.maxLive).toBeLessThanOrEqual(8)
    expect(fake.state.maxReads).toBeLessThanOrEqual(2)
    expect(fake.state.rateLimited).toBe(0)
    for (let i = 0; i < 12; i++) expect(snap(view, `img${i}`).status).not.toBe('error')
  })

  it('12 imagens visíveis ao mesmo tempo esperam em loading, sem erro, e respeitam os limites', async () => {
    const fake = fakeArtifacts()
    useFakeMaestro(fake)
    const view = render(
      <>
        {Array.from({ length: 12 }, (_, i) => (
          <Item key={i} name={`img${i}`} refId={id(100 + i)} />
        ))}
      </>
    )
    await advance(5000)
    const statuses = Array.from({ length: 12 }, (_, i) => snap(view, `img${i}`).status)
    expect(statuses.filter((s) => s === 'ready')).toHaveLength(8)
    expect(statuses.filter((s) => s === 'loading')).toHaveLength(4)
    expect(fake.state.maxLive).toBe(8)
    expect(fake.state.maxReads).toBe(2)
    expect(fake.state.rateLimited).toBe(0)
  })

  it('F6: anexos grandes não seguram as leituras; os chips pequenos de outra conversa abrem antes', async () => {
    const MIB = 1024 * 1024
    const fake = fakeArtifacts({
      readMsFor: (artifactId) => (artifactId === id(900) || artifactId === id(901) ? 20_000 : 10),
    })
    useFakeMaestro(fake)
    const view = render(
      <>
        <Item name="big1" refId={id(900)} sizeBytes={25 * MIB} />
        <Item name="big2" refId={id(901)} sizeBytes={24 * MIB} />
        {[0, 1, 2, 3, 4].map((i) => (
          <Item key={i} name={`small${i}`} threadId={T2} refId={id(910 + i)} sizeBytes={600 * 1024} />
        ))}
      </>
    )
    await advance(500)
    for (let i = 0; i < 5; i++) expect(snap(view, `small${i}`).status).toBe('ready')
    expect(snap(view, 'big1').status).toBe('loading')
    // Only one large read at a time: the second large file waits for the first.
    expect(fake.state.calls.filter((call) => call.artifactId === id(901))).toHaveLength(0)
    await advance(20_000)
    expect(snap(view, 'big1').status).toBe('ready')
    await advance(20_000)
    expect(snap(view, 'big2').status).toBe('ready')
    expect(fake.state.maxReads).toBeLessThanOrEqual(2)
    expect(fake.state.rateLimited).toBe(0)
  })

  it('RATE_LIMITED tenta de novo depois de 1 s, 2 s e fica pronto', async () => {
    const start = Date.now()
    const fake = fakeArtifacts({
      before: (call) => {
        if (call <= 2) throw new MaestroClientError('RATE_LIMITED', 'busy', true)
      },
    })
    useFakeMaestro(fake)
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(0)
    expect(fake.open).toHaveBeenCalledTimes(1)
    expect(snap(view, 'a').status).toBe('loading')
    await advance(999)
    expect(fake.open).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(fake.open).toHaveBeenCalledTimes(2)
    await advance(1999)
    expect(fake.open).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(fake.open).toHaveBeenCalledTimes(3)
    await advance(50)
    expect(snap(view, 'a').status).toBe('ready')
    expect(fake.state.calls.map((c) => c.at - start)).toEqual([0, 1000, 3000])
  })

  it('RATE_LIMITED depois de 1 s, 2 s e 4 s vira erro com o código', async () => {
    const start = Date.now()
    const fake = fakeArtifacts({
      before: () => {
        throw new MaestroClientError('RATE_LIMITED', 'busy', true)
      },
    })
    useFakeMaestro(fake)
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(20000)
    expect(fake.state.calls.map((c) => c.at - start)).toEqual([0, 1000, 3000, 7000])
    expect(snap(view, 'a')).toMatchObject({ status: 'error', code: 'RATE_LIMITED', url: '' })
  })

  it('outro erro não tenta de novo', async () => {
    const fake = fakeArtifacts({
      before: () => {
        throw new MaestroClientError('FORBIDDEN', 'no', false)
      },
    })
    useFakeMaestro(fake)
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(20000)
    expect(fake.open).toHaveBeenCalledTimes(1)
    expect(snap(view, 'a')).toMatchObject({ status: 'error', code: 'FORBIDDEN' })
  })

  it('trocar de thread cancela a leitura e libera o recurso', async () => {
    const fake = fakeArtifacts({ readMs: 500 })
    useFakeMaestro(fake)
    const view = render(<Item name="a" threadId={T1} refId={id(1)} />)
    await advance(100)
    const first = fake.state.calls[0]!
    expect(first.signal?.aborted).toBe(false)
    // Thread change while the read is in flight: abort.
    view.rerender(<Item name="a" threadId={T2} refId={id(1)} />)
    expect(first.signal?.aborted).toBe(true)
    await advance(1000)
    expect(fake.state.calls.at(-1)).toMatchObject({ threadId: T2 })
    expect(snap(view, 'a').status).toBe('ready')
    const ready = fake.state.resources[0]!
    // Thread change after the resource is ready: release.
    view.rerender(<Item name="a" threadId={T1} refId={id(1)} />)
    expect(ready.release).toHaveBeenCalled()
    expect(snap(view, 'a').url).toBe('')
    await advance(1000)
    expect(fake.state.live).toBe(1)
  })

  it('uma leitura que termina depois do cancelamento é liberada na hora', async () => {
    const fake = fakeArtifacts({ readMs: 500, ignoreAbort: true })
    useFakeMaestro(fake)
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(100)
    view.unmount()
    await advance(1000)
    expect(fake.state.resources).toHaveLength(1)
    expect(fake.state.resources[0]!.release).toHaveBeenCalled()
    expect(fake.state.live).toBe(0)
  })

  it('desmontar cancela e libera', async () => {
    const fake = fakeArtifacts()
    useFakeMaestro(fake)
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(100)
    expect(snap(view, 'a').status).toBe('ready')
    view.unmount()
    expect(fake.state.resources[0]!.release).toHaveBeenCalled()
    expect(fake.state.calls[0]!.signal?.aborted).toBe(true)
  })

  it('renova a URL antes dos 60 s do recurso', async () => {
    const fake = fakeArtifacts()
    useFakeMaestro(fake)
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(100)
    const firstUrl = snap(view, 'a').url
    expect(firstUrl).toBeTruthy()
    await advance(40000)
    expect(fake.open).toHaveBeenCalledTimes(1)
    await advance(15000)
    expect(fake.open).toHaveBeenCalledTimes(2)
    const next = snap(view, 'a')
    expect(next.status).toBe('ready')
    expect(next.url).not.toBe(firstUrl)
    expect(fake.state.resources[0]!.release).toHaveBeenCalled()
    expect(fake.state.live).toBe(1)
  })

  it('na renovação só revoga a URL antiga depois que o consumidor trocou para a nova', async () => {
    const fake = fakeArtifacts()
    useFakeMaestro(fake)
    const renders: { url: string | null; oldReleasedAtRender: boolean }[] = []
    function Probe() {
      const result = useMaestroArtifactUrl(T1, { refId: id(1), mimeType: 'audio/ogg', filename: 'a.ogg' })
      renders.push({ url: result.url, oldReleasedAtRender: fake.state.resources[0]?.released ?? false })
      return <div data-testid="p">{result.url ?? ''}</div>
    }
    const view = render(<Probe />)
    await advance(100)
    const firstUrl = view.getByTestId('p').textContent
    expect(firstUrl).toBeTruthy()
    await advance(50500)
    const nextUrl = view.getByTestId('p').textContent
    expect(nextUrl).not.toBe(firstUrl)
    // The render that shows the new URL happened while the old resource was still alive.
    const swap = renders.find((r) => r.url === nextUrl)!
    expect(swap.oldReleasedAtRender).toBe(false)
    // After the swap the old resource is released and only the new one is live.
    expect(fake.state.resources[0]!.released).toBe(true)
    expect(fake.state.resources[1]!.released).toBe(false)
    expect(fake.state.live).toBe(1)
  })

  describe('stable', () => {
    let created: string[]
    let revoked: string[]
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    beforeEach(() => {
      created = []
      revoked = []
      URL.createObjectURL = vi.fn(() => {
        const url = `blob:own#${created.length + 1}`
        created.push(url)
        return url
      }) as never
      URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url) }) as never
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['audio']) })))
    })
    afterEach(() => {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      vi.unstubAllGlobals()
    })

    it('copia o arquivo para um Blob próprio, libera o recurso na hora e mantém a mesma URL', async () => {
      const fake = fakeArtifacts()
      useFakeMaestro(fake)
      const view = render(<Item name="a" refId={id(1)} stable />)
      await advance(100)
      const first = snap(view, 'a')
      expect(first).toMatchObject({ status: 'ready' })
      expect(first.url).toBe('blob:own#1')
      expect(globalThis.fetch).toHaveBeenCalledWith(fake.state.resources[0]!.url, expect.anything())
      expect(fake.state.resources[0]!.released).toBe(true)
      // Renewal window: no second read, same URL, own blob not revoked.
      await advance(55000)
      expect(fake.open).toHaveBeenCalledTimes(1)
      expect(snap(view, 'a').url).toBe('blob:own#1')
      // Off screen for longer than the 60 s of the artifact: still the same URL.
      view.rerender(<Item name="a" refId={id(1)} visible={false} stable />)
      await advance(120000)
      expect(fake.open).toHaveBeenCalledTimes(1)
      expect(snap(view, 'a')).toMatchObject({ status: 'ready', url: 'blob:own#1' })
      view.rerender(<Item name="a" refId={id(1)} visible stable />)
      await advance(1000)
      expect(snap(view, 'a').url).toBe('blob:own#1')
      expect(revoked).toEqual([])
      view.unmount()
      expect(revoked).toEqual(['blob:own#1'])
    })

    describe('tipo do Blob próprio', () => {
      const copiedType = async (mimeType: string) => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x'], { type: mimeType }) })))
        useFakeMaestro(fakeArtifacts({ mimeType }))
        const view = render(<Item name="a" refId={id(1)} stable />)
        await advance(100)
        expect(snap(view, 'a').status).toBe('ready')
        const blob = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Blob
        view.unmount()
        return blob.type
      }
      it.each(['text/html', 'image/svg+xml', 'application/xml', 'application/json'])(
        '%s vira application/octet-stream',
        async (mime) => {
          expect(await copiedType(mime)).toBe('application/octet-stream')
        }
      )
      it.each(['application/pdf', 'image/png', 'audio/webm'])('%s mantém o tipo', async (mime) => {
        expect(await copiedType(mime)).toBe(mime)
      })
    })

    it('não ocupa a conta de 8 recursos vivos e não é evictado', async () => {
      const fake = fakeArtifacts({ readMs: 10 })
      useFakeMaestro(fake)
      const view = render(
        <>
          {Array.from({ length: 12 }, (_, i) => (
            <Item key={i} name={`a${i}`} refId={id(i + 1)} stable />
          ))}
        </>
      )
      await advance(2000)
      for (let i = 0; i < 12; i++) expect(snap(view, `a${i}`).status).toBe('ready')
      expect(fake.state.rateLimited).toBe(0)
      expect(revoked).toEqual([])
    })

    it('desmontar durante a cópia revoga o Blob próprio e libera o recurso', async () => {
      const fake = fakeArtifacts()
      useFakeMaestro(fake)
      let resolveBlob!: () => void
      vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveBlob = () => resolve({ ok: true, blob: async () => new Blob(['x']) }) })))
      const view = render(<Item name="a" refId={id(1)} stable />)
      await advance(100)
      view.unmount()
      resolveBlob()
      await advance(100)
      expect(fake.state.resources[0]!.released).toBe(true)
      expect(revoked).toEqual(created)
    })

    it('falha na cópia vira erro do hook e libera o recurso', async () => {
      const fake = fakeArtifacts()
      useFakeMaestro(fake)
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('blocked') }))
      const view = render(<Item name="a" refId={id(1)} stable />)
      await advance(100)
      expect(snap(view, 'a').status).toBe('error')
      expect(fake.state.resources[0]!.released).toBe(true)
    })
  })

  it('cliente antigo (AgentClient) devolve idle e não abre nada', async () => {
    const fake = fakeArtifacts()
    holder.client = new AgentClient({} as never)
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(100)
    expect(snap(view, 'a')).toMatchObject({ status: 'idle', url: '' })
    expect(fake.open).not.toHaveBeenCalled()
  })

  it('parte sem refId, com url ou sem thread devolve idle', async () => {
    const fake = fakeArtifacts()
    useFakeMaestro(fake)
    const view = render(
      <>
        <Item name="none" />
        <Item name="url" refId={id(1)} url="https://cdn.example/a.png" />
        <Item name="thread" threadId={null as never} refId={id(2)} />
      </>
    )
    await advance(100)
    for (const name of ['none', 'url', 'thread']) expect(snap(view, name)).toMatchObject({ status: 'idle', url: '' })
    expect(fake.open).not.toHaveBeenCalled()
  })

  it('arquivo que a história ainda não cita (mensagem otimista) espera e só abre quando o evento chega', async () => {
    const fake = fakeArtifacts()
    const history = useFakeMaestro(fake, fakeHistory(false))
    const view = render(<Item name="a" refId={id(1)} />)
    await advance(5000)
    // Opening before the server event cites the file is refused by the client and closed the thread.
    expect(fake.open).not.toHaveBeenCalled()
    expect(snap(view, 'a')).toMatchObject({ status: 'loading', url: '', code: '' })
    act(() => history.cite(T1, id(1)))
    await advance(100)
    expect(fake.open).toHaveBeenCalledTimes(1)
    expect(snap(view, 'a')).toMatchObject({ status: 'ready', url: `blob:${id(1)}#1` })
  })

  it('o arquivo citado em outra thread não libera a leitura nesta', async () => {
    const fake = fakeArtifacts()
    const history = useFakeMaestro(fake, fakeHistory(false))
    const view = render(<Item name="a" refId={id(1)} />)
    act(() => history.cite(T2, id(1)))
    await advance(100)
    expect(fake.open).not.toHaveBeenCalled()
    expect(snap(view, 'a').status).toBe('loading')
    view.unmount()
    // No listener stays on the store after the last consumer leaves.
    expect(history.listeners.size).toBe(0)
  })

  it('visible=false não abre até ficar visível', async () => {
    const fake = fakeArtifacts()
    useFakeMaestro(fake)
    const view = render(<Item name="a" refId={id(1)} visible={false} />)
    await advance(100)
    expect(fake.open).not.toHaveBeenCalled()
    expect(snap(view, 'a').status).toBe('idle')
    view.rerender(<Item name="a" refId={id(1)} visible />)
    await advance(100)
    expect(snap(view, 'a').status).toBe('ready')
  })
})

describe('useMaestroArtifactUrl com o cliente Maestro real', () => {
  it('a imagem da mensagem que a pessoa envia não fecha a thread e abre quando o evento chega', async () => {
    vi.useRealTimers()
    const headers = { 'Content-Type': 'image/png', 'Content-Length': '3', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="q.png"', 'X-Content-Type-Options': 'nosniff' }
    const fetcher = vi.fn(async (url: unknown) =>
      String(url).endsWith('/download') ? new Response('png', { headers }) : new Response('{}', { status: 503 })
    )
    const downloads = () => fetcher.mock.calls.map((call) => String(call[0])).filter((url) => url.endsWith('/download'))
    const env = make({ fetch: fetcher as never })
    const connecting = env.client.connect(); await tick(); const socket = env.sockets[0]!; socket.open(); await tick()
    socket.receive({ id: socket.last('connect').id, type: 'ack', payload: { status: 'connected', connection_id: uuid(100), server_version: '0.0.0', protocol_version: 1, history_authority: 'maestro', capabilities: ['messages.text', 'threads.shared', 'history.replay', 'attachments.durable'], expires_at: new Date(Date.now() + 300000).toISOString() } })
    await connecting
    env.client.retainThread(FIXTURE_THREAD); await tick(); socket.ackSubscribe()
    const first = event(1)
    first.payload.content = [{ type: 'attachment', artifact_id: uuid(40), filename: 'a.png', mime_type: 'image/png' }]
    const t = thread('1'); t.capabilities.push('attachments.durable')
    socket.frame('thread.snapshot', { thread: t, events: [first], watermark: '1', next_cursor: null, has_more: false }); socket.caught('1'); await tick()
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${URL.createObjectURL.mock.calls.length}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const client = Object.create(MaestroAgentClient.prototype) as MaestroAgentClient
    client.getMaestroClient = (() => env.client) as never
    holder.client = client
    const view = render(
      <>
        <Item name="sent" threadId={FIXTURE_THREAD} refId={uuid(40)} />
        <Item name="sending" threadId={FIXTURE_THREAD} refId={uuid(41)} />
      </>
    )
    await act(async () => { await tick(); await tick() })
    expect(snap(view, 'sent').status).toBe('ready')
    // The file of the message being sent is not cited yet: no read, no error, the thread stays open.
    expect(snap(view, 'sending')).toMatchObject({ status: 'loading', code: '' })
    expect(downloads()).toHaveLength(1)
    expect(env.client.store.getThread(FIXTURE_THREAD)?.phase).toBe('live')
    const echo = event(2)
    echo.payload.content = [{ type: 'attachment', artifact_id: uuid(41), filename: 'b.png', mime_type: 'image/png' }]
    await act(async () => { socket.frame('event.append', { event: echo, cursor: 'cursor-2' }); await tick(); await tick() })
    expect(snap(view, 'sending').status).toBe('ready')
    expect(downloads()).toHaveLength(2)
    expect(downloads()[1]).toContain(`/artifacts/${uuid(41)}/download`)
    view.unmount()
    env.client.dispose()
  })
})
