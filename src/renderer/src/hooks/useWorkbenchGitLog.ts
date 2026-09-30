import { useCallback, useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import {
  appendWorkbenchGitLogPage,
  isSameWorkbenchGitLog,
  isSameWorkbenchGitLogHead,
} from '@renderer/models/git/changesPanel.model'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type { SystemWorkspaceGitLogResult, WorkspaceGitLogEntry } from '@shared/contracts'

/** 提交图一页读这么多个提交；滚到底再读下一页。 */
export const WorkbenchGitLogPageSize = 200
/** 最多读进来这么多个提交：再往前的历史到这里为止，要看就限定到一个分支或者用搜索。 */
export const WorkbenchGitLogMaxCommits = 10_000

interface WorkbenchGitLogState {
  /** 这份日志属于哪个项目、哪个范围；换了才显示「读取中」，同一份刷新时原地更新。 */
  key: string
  commits: WorkspaceGitLogEntry[]
  hasMore: boolean
  error: Nullable<string>
}

export interface WorkbenchGitLog {
  commits: WorkspaceGitLogEntry[]
  /** 这个项目、这个范围的日志还一页都没读到。 */
  isLoading: boolean
  /** 读不出来的原因；已经列着的提交照旧显示。 */
  error: Nullable<string>
  hasMore: boolean
  isLoadingMore: boolean
  loadMore: () => void
}

const NoCommits: WorkspaceGitLogEntry[] = []

/**
 * Git 工具窗的提交日志，一页一页读。
 *
 * - `branch` 为空串是全部分支（本地分支和远端分支），否则只看这个分支。
 * - `revision` 是版本库状态的刷新序号（Git 摘要的时刻）：它一变就重读**第一页**，跟已经读到的开头比；
 *   一样（没有新提交、引用没动）就什么都不换，后面读过的页照旧作数——工作区每改一次摘要都会刷新，
 *   不能每次都把读过的几千个提交重读一遍。不一样时把已经读到的那一段整个重读，列表长度不变，滚到
 *   哪儿还在哪儿。
 * - 往后翻页与重读可能撞上：重读换掉了列表，那一页就作废（按代次认）。
 */
export function useWorkbenchGitLog({
  workspaceRoot,
  branch,
  enabled,
  revision,
}: {
  workspaceRoot: string
  branch: string
  enabled: boolean
  revision: Nullable<number>
}): WorkbenchGitLog {
  const [state, setState] = useState<Nullable<WorkbenchGitLogState>>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const stateRef = useRef<Nullable<WorkbenchGitLogState>>(null)
  /** 列表每被整个换掉一次加一：在那之前发起的翻页结果不再接上去。 */
  const generationRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const key = `${workspaceRoot}\0${branch}`

  const commit = useCallback((next: Nullable<WorkbenchGitLogState>): void => {
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1
      commit(null)
      return
    }
    let active = true
    const read = async (limit: number): Promise<SystemWorkspaceGitLogResult> =>
      Result.unwrap(
        await workbenchHost.kernel.workspace.getWorkspaceGitLog(workspaceRoot, {
          branch: branch || undefined,
          limit,
        })
      )

    void (async () => {
      const firstPage = await read(WorkbenchGitLogPageSize)
      if (!active) return
      const current = stateRef.current?.key === key ? stateRef.current : null
      if (current && !current.error && isSameWorkbenchGitLogHead(current.commits, firstPage.commits)) {
        // 已经读到的不满一页时，后面还有没有以这次为准（可能刚好多出来了）。
        if (current.commits.length <= firstPage.commits.length && current.hasMore !== firstPage.hasMore)
          commit({ ...current, hasMore: firstPage.hasMore })
        return
      }
      // 开头变了：已经读到的比一页长，就把那一段整个重读，否则这一页就是全部。
      const loaded = current?.commits.length ?? 0
      const result = loaded > WorkbenchGitLogPageSize ? await read(loaded) : firstPage
      if (!active) return
      const latest = stateRef.current?.key === key ? stateRef.current : null
      if (latest && !latest.error && isSameWorkbenchGitLog(latest.commits, result.commits)) return
      generationRef.current += 1
      commit({ key, commits: result.commits, hasMore: result.hasMore, error: null })
    })().catch((loadError: unknown) => {
      if (!active) return
      const current = stateRef.current?.key === key ? stateRef.current : null
      commit({
        key,
        commits: current?.commits ?? NoCommits,
        hasMore: current?.hasMore ?? false,
        error: AppError.getMessage(loadError),
      })
    })
    return () => {
      active = false
    }
  }, [branch, commit, enabled, key, revision, workspaceRoot])

  const loadMore = useCallback((): void => {
    const current = stateRef.current
    if (!current || current.key !== key || !current.hasMore || loadingMoreRef.current) return
    if (current.commits.length >= WorkbenchGitLogMaxCommits) return
    const generation = generationRef.current
    const skip = current.commits.length
    loadingMoreRef.current = true
    setIsLoadingMore(true)
    void workbenchHost.kernel.workspace
      .getWorkspaceGitLog(workspaceRoot, {
        branch: branch || undefined,
        limit: Math.min(WorkbenchGitLogPageSize, WorkbenchGitLogMaxCommits - skip),
        skip,
      })
      .then((result) => Result.unwrap(result))
      .then(
        (page) => {
          const latest = stateRef.current
          // 等这一页的工夫列表被换掉了（换了范围、仓库变了整段重读）：这一页接不上，丢掉。
          if (generation !== generationRef.current || latest?.key !== key) return
          const commits = appendWorkbenchGitLogPage(latest.commits, page.commits)
          commit({
            ...latest,
            commits,
            hasMore: page.hasMore && commits.length < WorkbenchGitLogMaxCommits,
          })
        },
        () => {
          // arch-guard:silent-catch-ok 下一页没读到：列表停在已经读到的地方，再滚到底会重试。
        }
      )
      .finally(() => {
        loadingMoreRef.current = false
        setIsLoadingMore(false)
      })
  }, [branch, commit, key, workspaceRoot])

  const current = state?.key === key ? state : null
  return {
    commits: current?.commits ?? NoCommits,
    isLoading: enabled && !current,
    // 刷新失败时已经列着的提交照旧显示，只有什么都没读到时才显示错误。
    error: current && !current.commits.length ? current.error : null,
    hasMore: current?.hasMore ?? false,
    isLoadingMore,
    loadMore,
  }
}
