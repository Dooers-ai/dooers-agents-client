/** The multipart part name production's `upload` gives a Blob (an audio recording has no name). */
export function blobPartFilename(blob: Blob, override?: string): string {
  const o = (override ?? '').trim()
  if (o) return o
  const t = (blob.type || '').toLowerCase()
  if (t.includes('webm')) return 'recording.webm'
  if (t.includes('ogg')) return 'recording.ogg'
  if (t.includes('mpeg') || t.includes('mp3')) return 'recording.mp3'
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'recording.m4a'
  if (t.startsWith('audio/')) return `recording.${t.split('/')[1]?.split('+')[0] || 'bin'}`
  return 'recording.bin'
}

/**
 * The file name production's `AgentClient.upload` sends: a `File` keeps its name trimmed (or the
 * name given, trimmed), `upload` when empty; a `Blob` without name gets `recording.webm` (by type).
 * Every Maestro upload path (chat, `useMaestroUploads`, form field) uses it, so the handler and the
 * history see the name production shows.
 */
export function productionUploadFilename(file: Blob, filename?: string): string {
  if (typeof File !== 'undefined' && file instanceof File)
    return filename?.trim() || file.name.trim() || 'upload'
  return blobPartFilename(file, filename)
}
