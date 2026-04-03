import { useCallback, useState } from 'react'

export interface SettingsFileMetadata {
  id?: string
  filename: string
  public_url?: string
  mime_type?: string
  size?: number
  [key: string]: unknown
}

export function useSettingsFileUpload() {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = useCallback(
    async (params: {
      file: File
      uploadUrl: string
      fieldId: string
      agentId: string
    }): Promise<SettingsFileMetadata> => {
      setIsUploading(true)
      setError(null)
      try {
        const formData = new FormData()
        formData.append('file', params.file)
        formData.append('source', 'settings')
        formData.append('field_id', params.fieldId)
        formData.append('agent_id', params.agentId)

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
