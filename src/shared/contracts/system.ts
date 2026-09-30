import type { WorkbenchGitBlame } from '../workbenchGitBlame'

import type {
  WorkspaceGitBranch,
  WorkspaceGitCommitResult,
  WorkspaceGitDiffOptions,
  WorkspaceGitDiffResult,
  WorkspaceGitFileAction,
  WorkspaceGitFileActionResult,
  WorkspaceGitFileStatusEntry,
  WorkspaceGitLineStats,
  WorkspaceGitLogEntry,
  WorkspaceGitLogOptions,
  WorkspaceGitRemoteAction,
  WorkspaceGitRemoteActionResult,
  WorkspaceGitRestoreResult,
  WorkspaceGitStatusResult,
} from './workspaceGit'

export type SystemDefaultEditorId =
  | 'velaros-light'
  | 'system'
  | 'visual-studio-code'
  | 'cursor'
  | 'windsurf'
  | 'trae'
  | 'zed'
  | 'webstorm'
  | 'sublime-text'

export interface SystemGitConfig {
  githubToken: string
  privateKeyPath: string
  /** @deprecated Use privateKeyPath. */
  sshKeyPath: string
}

export interface WorkspaceRootEntry {
  path: string
  active: boolean
  exists: boolean
  removable: boolean
  source: string
}

export interface SystemIntegrationDescriptor {
  id: string
  label: string
  description: string
  capabilities: string[]
}

export interface SystemOverview {
  providers: SystemIntegrationDescriptor[]
  workspaceRoots: WorkspaceRootEntry[]
  activeWorkspaceRoot: Nullable<string>
  browserSiteContext: Nullable<Record<string, unknown>>
}

export interface SystemWorkspaceFilesChangedEvent {
  kind: 'velaros.systemWorkspaceFilesChanged'
  source?: 'filesystem-watch' | 'file-change-transaction'
  rootPath: string
  paths: string[]
  sessionIds: string[]
  changedAt: number
}

export type SystemWorkspaceRootScope = 'project'

export interface SystemWorkspaceRootAddOptions {
  activate?: boolean
}

export interface SystemWorkspaceGitSummary {
  rootPath: Nullable<string>
  repository: boolean
  checkedAt: number
  status: Nullable<WorkspaceGitStatusResult>
  branches: WorkspaceGitBranch[]
  lineStats: WorkspaceGitLineStats
}

export interface SystemWorkspaceGitLineStatsSnapshot {
  rootPath: Nullable<string>
  repository: boolean
  checkedAt: number
  lineStats: WorkspaceGitLineStats
  branch: Nullable<string>
}

export interface SystemWorkspaceGitCommitResult {
  rootPath: string
  commit: WorkspaceGitCommitResult
  summary: SystemWorkspaceGitSummary
}

export interface SystemWorkspaceGitCommitMessageResult {
  rootPath: string
  message: Nullable<string>
}

export interface SystemWorkspaceGitDiffResult extends WorkspaceGitDiffResult {
  rootPath: string
}

export interface SystemWorkspaceGitFileAtCommitResult {
  rootPath: string
  content: string
}

/** 每一行最后是哪个提交改的。文件还没纳入版本管理时 `lines` 是空的。 */
export interface SystemWorkspaceGitBlameResult extends WorkbenchGitBlame {
  rootPath: string
}

export interface SystemWorkspaceGitSwitchBranchResult {
  rootPath: string
  previousBranch: Nullable<string>
  branch: string
  autoCommit: Nullable<WorkspaceGitCommitResult>
  restoredAutoCommit: Nullable<WorkspaceGitRestoreResult>
  summary: SystemWorkspaceGitSummary
}

export interface SystemWorkspaceGitCreateBranchResult {
  rootPath: string
  currentBranch: Nullable<string>
  branch: string
  summary: SystemWorkspaceGitSummary
}

export interface SystemWorkspaceGitInitializeRepositoryResult {
  rootPath: string
  summary: SystemWorkspaceGitSummary
}

export interface SystemWorkspaceGitLogResult {
  rootPath: string
  checkedAt: number
  commits: WorkspaceGitLogEntry[]
}

export interface SystemWorkspaceGitFileActionRequest {
  sessionId: string
  action: WorkspaceGitFileAction
  paths: string[]
}

export interface SystemWorkspaceGitFileActionResult {
  rootPath: string
  fileAction: WorkspaceGitFileActionResult
  summary: SystemWorkspaceGitSummary
}

export interface SystemWorkspaceGitHunkActionResult {
  rootPath: string
  summary: SystemWorkspaceGitSummary
}

export interface SystemWorkspaceGitActionRequest {
  sessionId: string
  action: WorkspaceGitRemoteAction
  branch?: string
  githubToken?: string
  privateKeyPath?: string
  sshKeyPath?: string
  /** 这次操作的编号：给了之后凭它中途取消。 */
  operationId?: string
}

export interface SystemWorkspaceGitActionResult {
  rootPath: string
  action: WorkspaceGitRemoteActionResult
  summary: SystemWorkspaceGitSummary
}

export interface SystemLocalAttachmentFileRequest {
  sessionId: string
  path: string
  name?: string
  mediaType?: string
  expectedSize?: number
  expectedLastModified?: number
}

export interface SystemLocalAttachmentFileResult {
  path: string
  name: string
  mediaType: string
  size: number
  lastModified: number
  data: Uint8Array
}

export interface SystemLocalAttachmentFileWriteRequest {
  sessionId: string
  path: string
  content: string
  expectedSize?: number
  expectedLastModified?: number
}

export interface SystemLocalAttachmentFileWriteResult {
  path: string
  size: number
  lastModified: number
}

export interface SystemOpenPathOptions {
  editor?: SystemDefaultEditorId
}

export interface SystemOpenPathResult {
  path: string
  opened: boolean
  editor?: SystemDefaultEditorId
  application?: LooseOptional<string>
}

export interface SystemFileChangePreviewResult {
  changeId: string
  rootPath?: string
  path: string
  created: boolean
  deleted?: boolean
  rolledBack: boolean
  revertAvailable?: boolean
  beforeContent: string
  afterContent: string
}

export interface SystemRollbackFileChangeResult {
  changeId: string
  path: string
  rolledBack: boolean
  alreadyRolledBack: boolean
}

export interface SystemRestoreFileChangeResult {
  changeId: string
  path: string
  rolledBack: boolean
  alreadyRestored: boolean
}

export type {
  WorkspaceGitBranch,
  WorkspaceGitCommitResult,
  WorkspaceGitDiffOptions,
  WorkspaceGitFileAction,
  WorkspaceGitFileStatusEntry,
  WorkspaceGitLineStats,
  WorkspaceGitLogEntry,
  WorkspaceGitLogOptions,
  WorkspaceGitRemoteAction,
  WorkspaceGitRemoteActionResult,
  WorkspaceGitStatusResult,
}
