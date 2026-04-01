import { useCallback, useState } from 'react'

export interface FormFileMetadata {
  id?: string
  filename: string
  public_url?: string
  mime_type?: string
  size?: number
  [key: string]: unknown
}

export function useFormFileUpload() {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = useCallback(
    async (params: {
      file: File
      uploadUrl: string
      fieldId: string
      agentId: string
      runId: string
      threadId: string
    }): Promise<FormFileMetadata> => {
      setIsUploading(true)
      setError(null)
      try {
        const formData = new FormData()
        formData.append('file', params.file)
        formData.append('field_id', params.fieldId)
        formData.append('source', 'chat')
        formData.append('agent_id', params.agentId)
        formData.append('run_id', params.runId)
        formData.append('thread_id', params.threadId)

        const response = await fetch(params.uploadUrl, {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail || `Upload failed (${response.status})`)
        }

        return await response.json()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        setError(message)
        throw err
      } finally {
        setIsUploading(false)
      }
    },
    []
  )

  const clearError = useCallback(() => setError(null), [])

  return { upload, isUploading, error, clearError }
}
