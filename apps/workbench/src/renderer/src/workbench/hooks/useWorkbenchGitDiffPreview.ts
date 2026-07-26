import { useEffect, useState } from 'react'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'
import type { SystemWorkspaceGitDiffResult } from '@velaros-ai/workbench/contracts'
import { workbenchHost } from '@velaros-ai/workbench/host'
import { resolveWorkbenchFullFileDiffContents } from '@velaros-ai/workbench/models/git/workbenchGitDiffModel'
import type { WorkbenchGitChangeItem } from '@velaros-ai/workbench/models/git/workbenchGitModel'

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

        const result = Result.unwrap(
          await workbenchHost.kernel.workspace.getWorkspaceGitDiff(projectRoot, {
            path: item.path,
            originalPath: item.originalPath,
            staged: item.group === 'staged',
            maxChars: FullFileMaxChars,
          })
        )

        const addedFile = item.indexStatus === 'A' || item.workTreeStatus === 'A'
        const deletedFile = item.indexStatus === 'D' || item.workTreeStatus === 'D'
        const [baseContent, currentFile] = await Promise.all([
          addedFile
            ? Promise.resolve('')
            : readHeadFileContent(projectRoot, item.originalPath ?? item.path),
          deletedFile
            ? Promise.resolve({ content: '', truncated: false })
            : readCurrentFileContent(projectRoot, item.path),
        ])
        const fullContents = resolveWorkbenchFullFileDiffContents({
          diff: result.diff,
          scope: result.scope === 'staged' ? 'staged' : 'working',
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
