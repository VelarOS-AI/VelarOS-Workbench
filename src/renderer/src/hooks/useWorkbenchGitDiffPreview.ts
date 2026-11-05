import { useCallback, useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import type { WorkbenchGitDiffPreviewScope } from '@renderer/models/git/changesPanel.model'
import {
  isWorkbenchGitDiffAffectedByChange,
  type WorkbenchGitPatchContent,
} from '@renderer/models/git/workbenchGitDiffModel'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'

import { AppError } from '@velaros-ai/velaros/core'
import { Result } from '@velaros-ai/velaros/core/result'

import { useMonotonicAsyncRequest } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'

const FullFileMaxChars = 1_000_000

/**
 * 一个改动的差异：git 的补丁（这一侧的，未跟踪文件没有），加上补丁一侧的全文，用来把没变的行也铺开。
 * - 已暂存：暂存区相对 HEAD，全文是 HEAD 里的那一版（改名的按改名前的路径读）。
 * - 未暂存：工作区相对暂存区，全文是工作区里的文件。
 * - 合并冲突：工作区相对 HEAD，全文是工作区里带冲突标记的那一版。
 * - 未跟踪：没有补丁，全文就是整个文件。
 */
export interface WorkbenchEditorDiffPreview {
  path: string
  scope: WorkbenchGitDiffPreviewScope
  diff: string
  /** 读不到、或读到的被截断了时为 null：只显示各块改动。 */
  content: Nullable<WorkbenchGitPatchContent>
  truncated: boolean
}

export interface WorkbenchGitDiffPreviewState {
  preview: Nullable<WorkbenchEditorDiffPreview>
  isLoading: boolean
  error: Nullable<string>
  /** 不等文件监听，马上原地重读一次（按块暂存、回滚之后）。 */
  reload: () => void
}

async function readWorkingFileContent(
  projectRoot: string,
  path: string
): Promise<Nullable<string>> {
  const result = Result.unwrap(
    await workbenchHost.kernel.project.readWorkbenchFile({
      projectRoot,
      path,
      maxChars: FullFileMaxChars,
    })
  )
  return result.truncated ? null : result.content
}

async function readHeadFileContent(projectRoot: string, path: string): Promise<string> {
  const result = Result.unwrap(
    await workbenchHost.kernel.workspace.getWorkspaceGitFileAtCommit(projectRoot, {
      commitSha: 'HEAD',
      path,
    })
  )
  return result.content
}

/** 补丁一侧的全文；这一侧没有这个文件（新增、删掉了）时是空的，读不到时为 null（只显示各块改动）。 */
async function readPatchContent(
  projectRoot: string,
  item: WorkbenchGitChangeItem
): Promise<Nullable<WorkbenchGitPatchContent>> {
  try {
    if (item.group === 'staged') {
      const added = item.indexStatus === 'A'
      return {
        side: 'old',
        text: added ? '' : await readHeadFileContent(projectRoot, item.originalPath ?? item.path),
      }
    }
    const deleted = item.group === 'unstaged' && item.workTreeStatus === 'D'
    const text = deleted ? '' : await readWorkingFileContent(projectRoot, item.path)
    return text === null ? null : { side: 'new', text }
  } catch {
    // 冲突里一方删掉了这个文件、读的时候文件刚好被删：只显示各块改动。
    return item.group === 'conflicted' ? { side: 'new', text: '' } : null
  }
}

async function loadWorkbenchGitDiffPreview(
  projectRoot: string,
  item: WorkbenchGitChangeItem
): Promise<WorkbenchEditorDiffPreview> {
  if (item.group === 'untracked') {
    const text = await readWorkingFileContent(projectRoot, item.path)
    return {
      path: item.path,
      scope: 'untracked',
      diff: '',
      content: text === null ? null : { side: 'new', text },
      truncated: text === null,
    }
  }

  const [result, content] = await Promise.all([
    workbenchHost.kernel.workspace.getWorkspaceGitDiff(projectRoot, {
      side: item.group === 'staged' || item.group === 'unstaged' ? item.group : undefined,
      path: item.path,
      originalPath: item.originalPath,
      maxChars: FullFileMaxChars,
    }),
    readPatchContent(projectRoot, item),
  ])
  const diff = Result.unwrap(result)
  return {
    path: item.path,
    scope: diff.scope,
    diff: diff.diff,
    content,
    truncated: diff.truncated,
  }
}

function isSamePreview(
  left: Nullable<WorkbenchEditorDiffPreview>,
  right: WorkbenchEditorDiffPreview
): boolean {
  return (
    !!left &&
    left.path === right.path &&
    left.scope === right.scope &&
    left.diff === right.diff &&
    left.content?.side === right.content?.side &&
    left.content?.text === right.content?.text &&
    left.truncated === right.truncated
  )
}

export function useWorkbenchGitDiffPreview({
  item,
  projectRoot,
}: {
  item: WorkbenchGitChangeItem
  projectRoot: string
}): WorkbenchGitDiffPreviewState {
  const [preview, setPreview] = useState<Nullable<WorkbenchEditorDiffPreview>>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Nullable<string>>(null)
  // 文件内容的版本：编辑器保存、Agent 写入、终端里改动都会让它加一，差异跟着重读。
  const [contentRevision, setContentRevision] = useState(0)
  /** 已经显示着的是哪个文件的差异：同一个文件重读时不闪「读取中」，读好了原地换上。 */
  const loadedFileRef = useRef<Nullable<string>>(null)
  const { abandonInFlightRequests, completeIfActive, isActive, start } = useMonotonicAsyncRequest()
  const fileKey = [projectRoot, item.originalPath ?? '', item.path].join('\0')

  useWorkspaceFilesChangedRefresh({
    rootPath: projectRoot,
    onChanged: (event) => {
      if (isWorkbenchGitDiffAffectedByChange(item, event))
        setContentRevision((revision) => revision + 1)
    },
  })

  useEffect(() => {
    const generation = start()
    const reloading = loadedFileRef.current === fileKey

    async function loadDiff(): Promise<void> {
      if (!reloading) {
        setIsLoading(true)
        setError(null)
      }

      try {
        const next = await loadWorkbenchGitDiffPreview(projectRoot, item)
        if (!isActive(generation)) return

        loadedFileRef.current = fileKey
        setError(null)
        setPreview((current) => (isSamePreview(current, next) ? current : next))
      } catch (loadError) {
        if (!isActive(generation)) return

        loadedFileRef.current = null
        setPreview(null)
        setError(AppError.getMessage(loadError))
      } finally {
        completeIfActive(generation, () => setIsLoading(false))
      }
    }

    void loadDiff()
    return () => {
      abandonInFlightRequests()
    }
    // `item` 每次刷新都是新对象：只在它的状态、路径真的变了，或文件内容变了时重读。
  }, [
    abandonInFlightRequests,
    completeIfActive,
    contentRevision,
    fileKey,
    isActive,
    item.group,
    item.indexStatus,
    item.originalPath,
    item.path,
    item.workTreeStatus,
    projectRoot,
    start,
  ])

  const reload = useCallback(() => setContentRevision((revision) => revision + 1), [])
  return { preview, isLoading, error, reload }
}
