import type { SystemWorkspaceGitDiffResult } from '@velaros/core/types'

export interface WorkbenchGitDiffPreview {
  path: string
  scope: SystemWorkspaceGitDiffResult['scope'] | 'untracked'
  diff: string
  truncated: boolean
}

export interface WorkbenchCommitDiffPreview {
  commitSha: string
  diff: string
  truncated: boolean
}
