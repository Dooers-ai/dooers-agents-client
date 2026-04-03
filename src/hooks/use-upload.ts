import { useCallback, useRef, useState } from 'react'
import type { UploadResult } from '../client'
import { useAgentContext } from '../provider'

export function useUpload() {
  const { client } = useAgentContext()
  const [isUploading, setIsUploading] = useState(false)
  const activeCountRef = useRef(0)

  const upload = useCallback(
    async (file: File | Blob): Promise<UploadResult> => {
      activeCountRef.current++
      setIsUploading(true)
      try {
        return await client.upload(file)
      } finally {
        activeCountRef.current--
        if (activeCountRef.current === 0) {
          setIsUploading(false)
        }
      }
    },
    [client]
  )

  return { upload, isUploading }
}
