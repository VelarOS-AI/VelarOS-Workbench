import { useEffect, useRef, useState } from 'react'

import { isEmpty, Log } from '@velaros-ai/velaros/core'

const log = Log.tag('workbench-history-search')

export interface WorkbenchHistorySearchIndex {
  /** record.id → 该版本文件内容；仅在 active（用户开始搜索）后按需加载。 */
  contents: ReadonlyMap<string, string>
  isIndexing: boolean
}

/**
 * 为「按文件内容搜索」惰性加载全部历史版本内容并缓存，本地历史与 Git 历史通用。
 * 数据源差异被 loadContent 抹平；loadContent 身份变化（切模式/文件）即重置缓存。
 * 按 id 缓存，切换搜索词不会重复请求。
 */
export function useWorkbenchHistorySearchIndex({
  records,
  loadContent,
  active,
}: {
  records: ReadonlyArray<{ id: string }>
  loadContent: (id: string) => Promise<string>
  active: boolean
}): WorkbenchHistorySearchIndex {
  const [contents, setContents] = useState<ReadonlyMap<string, string>>(new Map())
  const [isIndexing, setIsIndexing] = useState(false)
  const cacheRef = useRef<{ key: unknown; map: Map<string, string> }>({ key: null, map: new Map() })
  const generationRef = useRef(0)

  useEffect(() => {
    if (cacheRef.current.key !== loadContent) {
      cacheRef.current = { key: loadContent, map: new Map() }
      setContents(cacheRef.current.map)
    }

    if (!active || isEmpty(records)) return

    const missing = records.filter((record) => !cacheRef.current.map.has(record.id))
    if (isEmpty(missing)) {
      setContents(new Map(cacheRef.current.map))
      return
    }

    const generation = ++generationRef.current
    setIsIndexing(true)

    void (async () => {
      try {
        await Promise.all(
          missing.map(async (record) => {
            try {
              const content = await loadContent(record.id)
              if (generation === generationRef.current) {
                cacheRef.current.map.set(record.id, content)
              }
            } catch (error) {
              // 单条读取失败不阻断其它，缺失的记录搜索时视为不命中。
              log.warn('读取历史版本内容用于搜索失败', { id: record.id, error })
            }
          })
        )
      } finally {
        if (generation === generationRef.current) {
          setContents(new Map(cacheRef.current.map))
          setIsIndexing(false)
        }
      }
    })()
  }, [active, loadContent, records])

  return { contents, isIndexing }
}
