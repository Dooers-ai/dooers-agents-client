// Menções escritas no texto ("@Agente de Marketing", "@marketing") viram o campo estruturado
// `mentions` que o Maestro usa para decidir quem responde. Puro, sem I/O.

import type { MaestroNameResolver } from './maestro-legacy'
import type { MaestroParticipant } from './protocol/maestro/contracts'

/** "@todos" e afins: a mensagem é para todos, o mesmo que não mencionar ninguém. */
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
 * IDs de participante dos agentes mencionados, na ordem em que aparecem no texto. Vazio quando não
 * há menção a agente ou quando a mensagem é para todos ("@all", "@todos", "@todo").
 */
export function maestroMentions(
  text: string,
  participants: readonly MaestroParticipant[],
  resolve?: MaestroNameResolver
): string[] {
  const source = normalize(text)
  if (!source.includes('@')) return []
  const candidates = participants
    .filter((p) => p.kind === 'agent' && p.state !== 'removed')
    .flatMap((p) => {
      const id = p.kind === 'agent' ? p.instanceAgentId : p.principalId
      const name = resolve?.('agent', id)?.trim() || p.displayName
      return aliases(name).map((alias) => ({ alias, participantId: p.participantId }))
    })
    .sort((a, b) => b.alias.length - a.alias.length)
  const found: string[] = []
  for (let at = source.indexOf('@'); at !== -1; at = source.indexOf('@', at + 1)) {
    if (at > 0 && wordChar.test(source.charAt(at - 1))) continue
    const rest = source.slice(at + 1)
    const ends = (length: number) => !wordChar.test(rest.charAt(length))
    if (EVERYONE.some((word) => rest.startsWith(word) && ends(word.length))) return []
    const longest = candidates.find((c) => rest.startsWith(c.alias) && ends(c.alias.length))
    if (!longest) continue
    for (const c of candidates)
      if (c.alias === longest.alias && !found.includes(c.participantId)) found.push(c.participantId)
  }
  return found
}
