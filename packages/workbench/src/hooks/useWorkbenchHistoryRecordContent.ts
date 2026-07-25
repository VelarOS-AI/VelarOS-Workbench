import { useEffect, useRef, useState } from 'react'

import { AppError } from '@velaros-ai/core/error'

export interface WorkbenchHistoryRecordContent {
  content: Nullable<string>
  isLoading: boolean
  error: Nullable<string>
}

/** 读取当前选中历史记录（本地快照 / git 提交）的文件内容。 */
export function useWorkbenchHistoryRecordContent({
  loadContent,
  selectedId,
}: {
  loadContent: (id: string) => Promise<string>
  selectedId: Nullable<string>
}): WorkbenchHistoryRecordContent {
  const [content, setContent] = useState<Nullable<string>>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Nullable<string>>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    if (!selectedId) {
      setContent(null)
      setError(null)
      return
    }

    const generation = ++generationRef.current
    setIsLoading(true)
    setError(null)

    void (async () => {
      try {
        const next = await loadContent(selectedId)
        if (generation !== generationRef.current) return
        setContent(next)
      } catch (loadError) {
        if (generation !== generationRef.current) return
        setContent(null)
        setError(AppError.getMessage(loadError))
      } finally {
        if (generation === generationRef.current) setIsLoading(false)
      }
    })()
  }, [loadContent, selectedId])

  return { content, isLoading, error }
}
