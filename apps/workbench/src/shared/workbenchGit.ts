import type {
  AppLocale,
  SystemWorkspaceGitActionResult,
  SystemWorkspaceGitCommitMessageResult,
  SystemWorkspaceGitCommitResult,
  SystemWorkspaceGitCreateBranchResult,
  SystemWorkspaceGitDiffResult,
  SystemWorkspaceGitFileActionResult,
  SystemWorkspaceGitFileAtCommitResult,
  SystemWorkspaceGitInitializeRepositoryResult,
  SystemWorkspaceGitLineStatsSnapshot,
  SystemWorkspaceGitLogResult,
  SystemWorkspaceGitSummary,
  SystemWorkspaceGitSwitchBranchResult,
  WorkspaceGitDiffOptions,
  WorkspaceGitFileAction,
  WorkspaceGitLogOptions,
  WorkspaceGitRemoteAction,
  WorkspaceGitRemoteActionOptions,
} from '@velaros-ai/core/types'

import type { WorkbenchFsCallResult } from './workbenchFs'

export const WorkbenchGitChannels = {
  summary: 'workbench-app:git:summary',
  lineStats: 'workbench-app:git:line-stats',
  diff: 'workbench-app:git:diff',
  fileAtCommit: 'workbench-app:git:file-at-commit',
  log: 'workbench-app:git:log',
  generateCommitMessage: 'workbench-app:git:generate-commit-message',
  commit: 'workbench-app:git:commit',
  fileAction: 'workbench-app:git:file-action',
  initialize: 'workbench-app:git:initialize',
  switchBranch: 'workbench-app:git:switch-branch',
  createBranch: 'workbench-app:git:create-branch',
  remoteAction: 'workbench-app:git:remote-action',
} as const

export interface WorkbenchGitRootRequest {
  workspaceRoot: string
}

export interface WorkbenchGitDiffRequest extends WorkbenchGitRootRequest, WorkspaceGitDiffOptions {}

export interface WorkbenchGitFileAtCommitRequest extends WorkbenchGitRootRequest {
  commitSha: string
  path: string
}

export interface WorkbenchGitLogRequest extends WorkbenchGitRootRequest, WorkspaceGitLogOptions {}

export interface WorkbenchGitCommitMessageRequest extends WorkbenchGitRootRequest {
  locale?: AppLocale
  paths?: string[]
}

export interface WorkbenchGitCommitRequest extends WorkbenchGitCommitMessageRequest {
  message?: string
}

export interface WorkbenchGitFileActionRequest extends WorkbenchGitRootRequest {
  path: string
  action: WorkspaceGitFileAction
}

export interface WorkbenchGitSwitchBranchRequest extends WorkbenchGitRootRequest {
  branch: string
  create?: boolean
  startPoint?: string
  locale?: AppLocale
}

export interface WorkbenchGitCreateBranchRequest extends WorkbenchGitRootRequest {
  branch: string
}

export interface WorkbenchGitRemoteActionRequest
  extends WorkbenchGitRootRequest,
    WorkspaceGitRemoteActionOptions {
  action: WorkspaceGitRemoteAction
}

export interface WorkbenchGitBridge {
  getSummary(
    request: WorkbenchGitRootRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitSummary>>
  getLineStats(
    request: WorkbenchGitRootRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitLineStatsSnapshot>>
  getDiff(
    request: WorkbenchGitDiffRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitDiffResult>>
  getFileAtCommit(
    request: WorkbenchGitFileAtCommitRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitFileAtCommitResult>>
  getLog(
    request: WorkbenchGitLogRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitLogResult>>
  generateCommitMessage(
    request: WorkbenchGitCommitMessageRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitCommitMessageResult>>
  commit(
    request: WorkbenchGitCommitRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitCommitResult>>
  performFileAction(
    request: WorkbenchGitFileActionRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitFileActionResult>>
  initialize(
    request: WorkbenchGitRootRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitInitializeRepositoryResult>>
  switchBranch(
    request: WorkbenchGitSwitchBranchRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitSwitchBranchResult>>
  createBranch(
    request: WorkbenchGitCreateBranchRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitCreateBranchResult>>
  performRemoteAction(
    request: WorkbenchGitRemoteActionRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitActionResult>>
}
