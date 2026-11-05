import { useCallback, useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import { isSameWorkbenchGitStashList } from '@renderer/models/git/workbenchGitStashModel'

import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import { type WorkspaceGitStash } from '@shared/contracts/workspaceGit'

interface WorkbenchGitStashesState {
  workspaceRoot: string
  stashes: WorkspaceGitStash[]
  error: Nullable<string>
}

/** 还没读到时的空列表：同一个对象，依赖它的 memo 不会每次渲染都重算。 */
const EmptyStashes: WorkspaceGitStash[] = []

export interface WorkbenchGitStashes {
  stashes: WorkspaceGitStash[]
  /** 列表读不出来的原因；已经列着的贮藏照旧显示。 */
  error: Nullable<string>
  /** 贮藏操作带回了新的列表：直接换上，不等下一次刷新。 */
  replace: (stashes: WorkspaceGitStash[]) => void
}

/**
 * 仓库里的贮藏列表。`revision` 是版本库状态的刷新序号（Git 摘要的时刻）：在终端里贮藏、取回之后
 * `.git/refs/stash` 变了，摘要跟着刷新，这里跟着重读；原地更新，列表不闪。`enabled` 为 false（不是仓库、
 * 面板没开）时不读。
 */
export function useWorkbenchGitStashes({
  workspaceRoot,
  enabled,
  revision,
}: {
  workspaceRoot: string
  enabled: boolean
  revision: Nullable<number>
}): WorkbenchGitStashes {
  const [state, setState] = useState<Nullable<WorkbenchGitStashesState>>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    if (!enabled) {
      setState(null)
      return
    }
    void workbenchHost.kernel.workspace
      .listWorkspaceGitStashes(workspaceRoot)
      .then((result) => Result.unwrap(result).stashes)
      .then(
        (stashes) => {
          if (generation !== generationRef.current) return
          setState((current) =>
            current?.workspaceRoot === workspaceRoot &&
            !current.error &&
            isSameWorkbenchGitStashList(current.stashes, stashes)
              ? current
              : { workspaceRoot, stashes, error: null }
          )
        },
        (error: unknown) => {
          if (generation !== generationRef.current) return
          const message = AppError.getMessage(error)
          setState((current) => ({
            workspaceRoot,
            stashes: current?.workspaceRoot === workspaceRoot ? current.stashes : [],
            error: message,
          }))
        }
      )
  }, [enabled, revision, workspaceRoot])

  const replace = useCallback(
    (stashes: WorkspaceGitStash[]): void => {
      // 正在路上的那次读取是操作之前发起的，作废它，免得旧列表盖回来。
      generationRef.current += 1
      setState({ workspaceRoot, stashes, error: null })
    },
    [workspaceRoot]
  )

  const current = state?.workspaceRoot === workspaceRoot ? state : null
  return { stashes: current?.stashes ?? EmptyStashes, error: current?.error ?? null, replace }
}
