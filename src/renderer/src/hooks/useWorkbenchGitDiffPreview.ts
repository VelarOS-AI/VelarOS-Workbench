import { useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import {
  isWorkbenchGitDiffAffectedByChange,
  resolveWorkbenchFullFileDiffContents,
} from '@renderer/models/git/workbenchGitDiffModel'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import type { SystemWorkspaceGitDiffResult } from '@shared/contracts'

import { useMonotonicAsyncRequest } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'

const FullFileMaxChars = 1_000_000

interface WorkbenchDiffFileContent {
  content: string
  truncated: boolean
}

export interface WorkbenchEditorDiffPreview {
  path: string
  scope: SystemWorkspaceGitDiffResult['scope'] | 'untracked'
  beforeContent: string
  afterContent: string
  truncated: boolean
}

export interface WorkbenchGitDiffPreviewState {
  preview: Nullable<WorkbenchEditorDiffPreview>
  isLoading: boolean
  error: Nullable<string>
}

async function readCurrentFileContent(
  projectRoot: string,
  path: string
): Promise<WorkbenchDiffFileContent> {
  const result = Result.unwrap(
    await workbenchHost.kernel.project.readWorkbenchFile({
      projectRoot,
      path,
      maxChars: FullFileMaxChars,
    })
  )
  return { content: result.content, truncated: result.truncated }
}

async function readHeadFileContent(
  projectRoot: string,
  path: string
): Promise<string> {
  const result = Result.unwrap(
    await workbenchHost.kernel.workspace.getWorkspaceGitFileAtCommit(projectRoot, {
      commitSha: 'HEAD',
      path,
    })
  )
  return result.content
}

/**
 * 差异两侧：HEAD 里的样子 → 工作区里的样子，也就是提交会带走的内容（提交面板提交的是工作区里的文件，
 * 暂存了一半的文件也按整份算）。冲突文件哪一侧都可能不在（一方删掉了），读不到的一侧按空文件算。
 */
async function loadWorkbenchGitDiffPreview(
  projectRoot: string,
  item: WorkbenchGitChangeItem
): Promise<WorkbenchEditorDiffPreview> {
  if (item.group === 'untracked') {
    const file = await readCurrentFileContent(projectRoot, item.path)
    return {
      path: item.path,
      scope: 'untracked',
      beforeContent: '',
      afterContent: file.content,
      truncated: file.truncated,
    }
  }

  const result = Result.unwrap(
    await workbenchHost.kernel.workspace.getWorkspaceGitDiff(projectRoot, {
      path: item.path,
      originalPath: item.originalPath,
      maxChars: FullFileMaxChars,
    })
  )
  const conflicted = item.group === 'conflicted'
  const addedFile = !conflicted && (item.indexStatus === 'A' || item.workTreeStatus === 'A')
  const deletedFile = !conflicted && (item.indexStatus === 'D' || item.workTreeStatus === 'D')
  const [baseContent, currentFile] = await Promise.all([
    addedFile
      ? Promise.resolve('')
      : readHeadFileContent(projectRoot, item.originalPath ?? item.path).catch((error) => {
          if (conflicted) return ''
          throw error
        }),
    deletedFile
      ? Promise.resolve({ content: '', truncated: false })
      : readCurrentFileContent(projectRoot, item.path).catch((error) => {
          if (conflicted) return { content: '', truncated: false }
          throw error
        }),
  ])
  const fullContents = resolveWorkbenchFullFileDiffContents({
    diff: result.diff,
    scope: 'working',
    baseContent,
    currentContent: currentFile.content,
  }) ?? {
    beforeContent: baseContent,
    afterContent: currentFile.content,
  }
  return {
    path: item.path,
    scope: result.scope,
    beforeContent: fullContents.beforeContent,
    afterContent: fullContents.afterContent,
    truncated: result.truncated || currentFile.truncated,
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
    left.beforeContent === right.beforeContent &&
    left.afterContent === right.afterContent &&
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

  return { preview, isLoading, error }
}
