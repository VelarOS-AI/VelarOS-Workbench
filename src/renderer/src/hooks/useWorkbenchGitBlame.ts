import { useEffect, useState } from 'react'

import type { WorkbenchGitBlame } from '@shared/workbenchGitBlame'
import type { WorkbenchTextFormat } from '@shared/workbenchTextFormat'

import { useWorkbenchHostRuntime } from '../host'
import { useLatest } from '../support/genericHooks'

/** 追溯栏开着时交给编辑器的：哪个文件的结果；还在查、查不到（没纳入版本管理、不是仓库）时 `blame` 为 null。 */
export interface WorkbenchEditorGitBlame {
  path: string
  blame: Nullable<WorkbenchGitBlame>
}

interface GitBlameState extends WorkbenchEditorGitBlame {
  projectRoot: string
}

/**
 * 查当前文件每一行最后是哪个提交改的。`path` 为 null（追溯栏关着、当前不是代码文件）时不查，返回 null。
 *
 * 按编辑器里此刻的正文查（`readContent`），没保存的改动也对得上行。什么时候重查：换文件、版本库状态变了
 * （`revision`：提交、切分支、拉取）、文件存盘了（`savedAt`）。两次之间的编辑由编辑器自己跟着移动标注。
 */
export function useWorkbenchGitBlame({
  projectRoot,
  path,
  revision,
  savedAt,
  format,
  readContent,
}: {
  projectRoot: string
  path: Nullable<string>
  revision: Nullable<number>
  savedAt: Nullable<number>
  format: WorkbenchTextFormat
  readContent: () => string
}): Nullable<WorkbenchEditorGitBlame> {
  const hostRuntime = useWorkbenchHostRuntime()
  const [state, setState] = useState<Nullable<GitBlameState>>(null)
  const readContentLatest = useLatest(readContent)
  const { encoding, eol } = format

  useEffect(() => {
    if (!path || revision === null) return undefined

    let cancelled = false
    void hostRuntime.kernel.workspace
      .getWorkspaceGitBlame(projectRoot, {
        path,
        content: readContentLatest.current(),
        encoding,
        eol,
      })
      .then(
        (result) => (result.ok && result.data.lines.length > 0 ? result.data : null),
        () => null
      )
      .then((blame) => {
        if (!cancelled) setState({ projectRoot, path, blame })
      })
    return () => {
      cancelled = true
    }
  }, [encoding, eol, hostRuntime, path, projectRoot, readContentLatest, revision, savedAt])

  if (!path) return null
  return state && state.projectRoot === projectRoot && state.path === path
    ? state
    : { path, blame: null }
}
