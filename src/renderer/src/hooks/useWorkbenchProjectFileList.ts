import { useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import { isWorkbenchProjectFileListChange } from '@renderer/models/files/workbenchProjectFileList'

import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type { SystemWorkspaceFilesChangedEvent } from '@shared/contracts'

import {
  useDebounceFn,
  useLatest,
  useMemoizedFn,
  useMonotonicAsyncRequest,
} from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'

const log = Log.tag('workbench-project-file-list')
/** 快速打开开着时，文件接连变动的最后一次之后隔多久重读清单。 */
const OpenRefreshDelayMs = 400
/** 项目打开后空闲时先把清单读好；一直不空闲最多等这么久。 */
const PrefetchIdleTimeoutMs = 4_000

interface ProjectFileList {
  projectRoot: string
  files: readonly string[]
  truncated: boolean
}

export interface WorkbenchProjectFileListState {
  /** 当前项目的文件清单；还没读到为 null。 */
  files: Nullable<readonly string[]>
  /** 超出上限，只列了离根近的那一部分。 */
  truncated: boolean
  isLoading: boolean
}

interface UseWorkbenchProjectFileListOptions {
  projectRoot: Nullable<string>
  /** 快速打开开着：清单过期了马上重读；关着只记下过期，下次打开时再读。 */
  active: boolean
}

/**
 * 快速打开按文件名找文件用的整份文件清单，按项目缓存在手上。项目打开后空闲时先读一次；之后文件监听报了
 * 会改变清单的变动就记为过期，到快速打开开着时再重读——读的时候先用手上这一份，读好了再换。
 */
export function useWorkbenchProjectFileList({
  projectRoot,
  active,
}: UseWorkbenchProjectFileListOptions): WorkbenchProjectFileListState {
  const [list, setList] = useState<Nullable<ProjectFileList>>(null)
  const [isLoading, setIsLoading] = useState(false)
  const staleRef = useRef(true)
  const activeRef = useLatest(active)
  const { abandonInFlightRequests, completeIfActive, isActive, start } = useMonotonicAsyncRequest()

  const load = useMemoizedFn((): void => {
    const root = projectRoot
    if (!root) return

    staleRef.current = false
    const generation = start()
    setIsLoading(true)
    void (async () => {
      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.listWorkbenchProjectFiles({ projectRoot: root })
        )
        if (!isActive(generation)) return

        setList({ projectRoot: root, files: result.files, truncated: result.truncated })
      } catch (error) {
        if (!isActive(generation)) return
        // 读不到就接着用手上这一份（内容搜索照常），下次打开再试。
        staleRef.current = true
        log.warn('读取项目文件清单失败', { projectRoot: root, error: AppError.getMessage(error) })
      } finally {
        completeIfActive(generation, () => setIsLoading(false))
      }
    })()
  })

  const { run: scheduleRefresh, cancel: cancelScheduledRefresh } = useDebounceFn(load, {
    wait: OpenRefreshDelayMs,
  })

  useEffect(() => {
    abandonInFlightRequests()
    cancelScheduledRefresh()
    staleRef.current = true
    setList(null)
    setIsLoading(false)
    if (!projectRoot) return undefined

    const prefetch = (): void => {
      if (staleRef.current) load()
    }
    if (!window.requestIdleCallback) {
      const timer = window.setTimeout(prefetch, 1_000)
      return () => window.clearTimeout(timer)
    }
    const handle = window.requestIdleCallback(prefetch, { timeout: PrefetchIdleTimeoutMs })
    return () => window.cancelIdleCallback(handle)
  }, [abandonInFlightRequests, cancelScheduledRefresh, load, projectRoot])

  useEffect(() => {
    if (active && staleRef.current) load()
  }, [active, load])

  useWorkspaceFilesChangedRefresh({
    rootPath: projectRoot,
    enabled: !!projectRoot,
    onChanged: (event: SystemWorkspaceFilesChangedEvent) => {
      if (!event.paths.some(isWorkbenchProjectFileListChange)) return

      staleRef.current = true
      if (activeRef.current) scheduleRefresh()
    },
  })

  const current = list?.projectRoot === projectRoot ? list : null
  return {
    files: current?.files ?? null,
    truncated: current?.truncated ?? false,
    isLoading,
  }
}
