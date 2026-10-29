// Menções escritas no texto ("@Agente de Marketing", "@marketing") viram o campo estruturado
// `mentions` que o Maestro usa para decidir quem responde. Puro, sem I/O.

import type { MaestroNameResolver } from './maestro-legacy'
import type { MaestroParticipant } from './protocol/maestro/contracts'

/** "@todos" e afins: todos os agentes da conversa são mencionados e cada um tem que responder. */
const EVERYONE = ['all', 'todos', 'todas', 'todo', 'everyone']

const normalize = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
const wordChar = /[\p{L}\p{N}_]/u

/** Nome completo e, sem o prefixo "Agente (de|do|da)", o nome curto. */
function aliases(name: string): string[] {
  const full = normalize(name)
  const short = full.replace(/^agente\s+(?:(?:de|do|da|dos|das)\s+)?/, '')
  return [...new Set([full, short])].filter((alias) => alias.length >= 3 && alias !== 'agente')
}

/**
 * IDs de participante dos agentes mencionados, na ordem em que aparecem no texto. "@all", "@todos" ou
 * "@todo" mencionam todos os agentes, na ordem de entrada na conversa. Vazio sem menção a agente.
 */
export function maestroMentions(
  text: string,
  participants: readonly MaestroParticipant[],
  resolve?: MaestroNameResolver,
  strict = false
): string[] {
  const source = normalize(text)
  if (!source.includes('@')) return []
  const agents = participants.filter(
    (p) => p.kind === 'agent' && (strict ? p.state === 'active' : p.state !== 'removed')
  )
  const everyone = () =>
    [...agents]
      .sort((a, b) => {
        const delta = BigInt(a.joinedSequence) - BigInt(b.joinedSequence)
        return delta < 0n ? -1 : delta > 0n ? 1 : a.participantId.localeCompare(b.participantId)
      })
      .map((p) => p.participantId)
  const mentionable = strict ? participants.filter((p) => p.state === 'active') : agents
  const candidates = mentionable
    .flatMap((p) => {
      const id = p.kind === 'agent' ? p.instanceAgentId : p.principalId
      const name = resolve?.(p.kind, id)?.trim() || p.displayName
      return aliases(name).map((alias) => ({ alias, participantId: p.participantId }))
    })
    .sort((a, b) => b.alias.length - a.alias.length)
  const found: string[] = []
  for (let at = source.indexOf('@'); at !== -1; at = source.indexOf('@', at + 1)) {
    if (at > 0 && wordChar.test(source.charAt(at - 1))) continue
    const rest = source.slice(at + 1)
    const ends = (length: number) => !wordChar.test(rest.charAt(length))
    if (EVERYONE.some((word) => rest.startsWith(word) && ends(word.length))) return everyone()
    const longest = candidates.find((c) => rest.startsWith(c.alias) && ends(c.alias.length))
    if (!longest) {
      if (strict) throw new Error('Menção não encontrada')
      continue
    }
    if (
      new Set(candidates.filter((c) => c.alias === longest.alias).map((c) => c.participantId))
        .size > 1
    )
      throw new Error('Menção ambígua; selecione um destinatário com nome único')
    for (const c of candidates)
      if (c.alias === longest.alias && !found.includes(c.participantId)) found.push(c.participantId)
  }
  return found
}

/** Same delimiter rules as the ID parser; punctuation cannot turn all into persistent direct. */
export function maestroMentionsEveryone(text: string): boolean {
  const source = normalize(text)
  for (let at = source.indexOf('@'); at !== -1; at = source.indexOf('@', at + 1)) {
    if (at > 0 && wordChar.test(source.charAt(at - 1))) continue
    const rest = source.slice(at + 1)
    if (EVERYONE.some((word) => rest.startsWith(word) && !wordChar.test(rest.charAt(word.length))))
      return true
  }
  return false
}
