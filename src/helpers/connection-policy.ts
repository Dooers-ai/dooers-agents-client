export const MAX_CONSECUTIVE_FAILURES = 5
/** A `getAuthToken` call that has not settled by then counts as failed. */
export const AUTH_TOKEN_TIMEOUT_MS = 15_000
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const
export const PING_INTERVAL_MS = 30_000
export const LIVENESS_TIMEOUT_MS = 90_000
/** Silence allowed while a run or request is in progress: the server may not answer pings then. */
export const LIVENESS_BUSY_TIMEOUT_MS = 300_000
/** A connected socket that stays up this long resets the failure count; one lost sooner counts. */
export const STABLE_CONNECTION_MS = 30_000
export const ROTATE_AFTER_MS = 30 * 60_000
export const ROTATE_DEADLINE_MS = 55 * 60_000

/** Backoff for the given number of consecutive failures, with +-20% jitter. */
export function reconnectDelayMs(failures: number, random: () => number = Math.random): number {
  const base = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)] as number
  return base * (0.8 + 0.4 * random())
}

/** Whether a connection of this age should be renewed now. */
export function rotationDue(ageMs: number, idle: boolean): boolean {
  return ageMs >= ROTATE_DEADLINE_MS || (ageMs >= ROTATE_AFTER_MS && idle)
}
