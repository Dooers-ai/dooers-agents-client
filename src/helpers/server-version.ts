/** Minimum agents-server semver for ``thread.artifacts.list`` (includes connect ``server.version``). */
export const THREAD_ARTIFACTS_MIN_SERVER_VERSION = '0.17.1'

/** Minimum agents-server semver for ``event.create`` ``chat_context``. */
export const CHAT_CONTEXT_MIN_SERVER_VERSION = '0.19.0'

/** Parse ``major.minor.patch`` prefix; non-numeric parts become 0. */
function parseSemverParts(version: string): [number, number, number] {
  const core = version.trim().split('-')[0]?.split('+')[0] ?? ''
  const [maj, min, pat] = core.split('.')
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0]
}

/** Compare semver strings. Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemverParts(a)
  const [bMaj, bMin, bPat] = parseSemverParts(b)
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1
  if (aMin !== bMin) return aMin < bMin ? -1 : 1
  if (aPat !== bPat) return aPat < bPat ? -1 : 1
  return 0
}

export function isServerAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (!version?.trim()) return false
  return compareSemver(version, minimum) >= 0
}

export function supportsThreadArtifactsList(serverVersion: string | null | undefined): boolean {
  return isServerAtLeast(serverVersion, THREAD_ARTIFACTS_MIN_SERVER_VERSION)
}

export function supportsChatContext(serverVersion: string | null | undefined): boolean {
  return isServerAtLeast(serverVersion, CHAT_CONTEXT_MIN_SERVER_VERSION)
}
