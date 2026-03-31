/**
 * Browser `WebSocket` and Node's `WebSocket` require `ws:` / `wss:` URLs.
 * Agent "API Messages URL" is often stored as `https://host/ws` — normalize before connecting.
 */
export function apiMessagesUrlToWebSocketUrl(url: string): string {
  const t = url.trim()
  if (!t) {
    throw new Error('API Messages URL is empty')
  }
  if (/^wss:\/\//i.test(t) || /^ws:\/\//i.test(t)) {
    return t
  }
  if (/^https:\/\//i.test(t)) {
    return `wss://${t.slice('https://'.length)}`
  }
  if (/^http:\/\//i.test(t)) {
    return `ws://${t.slice('http://'.length)}`
  }
  throw new Error('API Messages URL must start with http://, https://, ws://, or wss://')
}
