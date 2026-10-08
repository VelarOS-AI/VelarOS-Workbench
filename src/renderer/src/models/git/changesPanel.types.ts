import { type SystemWorkspaceGitDiffResult } from '@shared/contracts/system'

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
