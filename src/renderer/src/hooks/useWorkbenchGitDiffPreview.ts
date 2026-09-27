import { useEffect, useState } from 'react'
import { workbenchHost } from '@renderer/host'
import { resolveWorkbenchFullFileDiffContents } from '@renderer/models/git/workbenchGitDiffModel'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import type { SystemWorkspaceGitDiffResult } from '@shared/contracts'

import { useMonotonicAsyncRequest } from '../support/genericHooks'

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
  const { abandonInFlightRequests, completeIfActive, isActive, start } = useMonotonicAsyncRequest()

  useEffect(() => {
    const generation = start()

    async function loadDiff(): Promise<void> {
      setIsLoading(true)
      setError(null)

      try {
        if (item.group === 'untracked') {
          const file = await readCurrentFileContent(projectRoot, item.path)

          if (!isActive(generation)) return

          setPreview({
            path: item.path,
            scope: 'untracked',
            beforeContent: '',
            afterContent: file.content,
            truncated: file.truncated,
          })
          return
        }

        // HEAD 里的样子 → 工作区里的样子，也就是提交会带走的内容：提交面板提交的是工作区里的文件，
        // 暂存了一半的文件也按整份算。
        const result = Result.unwrap(
          await workbenchHost.kernel.workspace.getWorkspaceGitDiff(projectRoot, {
            path: item.path,
            originalPath: item.originalPath,
            maxChars: FullFileMaxChars,
          })
        )

        // 冲突文件哪一侧都可能不在（一方删掉了）：读不到的一侧按空文件算。
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

        if (!isActive(generation)) return

        setPreview({
          path: item.path,
          scope: result.scope,
          beforeContent: fullContents.beforeContent,
          afterContent: fullContents.afterContent,
          truncated: result.truncated || currentFile.truncated,
        })
      } catch (loadError) {
        if (!isActive(generation)) return

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
  }, [
    abandonInFlightRequests,
    completeIfActive,
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
