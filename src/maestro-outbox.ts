import type { MaestroSendInput } from './maestro/types'

/** Persist exact publication intents before transport; the server deduplicates by clientEventId. */
export class MaestroOutbox {
  constructor(private readonly prefix: string, private readonly storage: Storage | undefined) {}

  put(input: MaestroSendInput) {
    this.storage?.setItem(this.prefix + input.clientEventId, JSON.stringify(input))
  }

  remove(id: string) {
    this.storage?.removeItem(this.prefix + id)
  }

  entries(): MaestroSendInput[] {
    const entries: MaestroSendInput[] = []
    if (!this.storage) return entries
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)
      if (!key?.startsWith(this.prefix)) continue
      try {
        const input = JSON.parse(this.storage.getItem(key) ?? 'null')
        if (input && typeof input.clientEventId === 'string' && typeof input.threadId === 'string' && Array.isArray(input.content))
          entries.push(input)
      } catch { /* Ignore corrupt storage; never send an invented intent. */ }
    }
    return entries
  }
}
