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
} from '@shared/contracts'

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
  captureChatCheckpoint: 'workbench-app:git:capture-chat-checkpoint',
  restoreChatCheckpoint: 'workbench-app:git:restore-chat-checkpoint',
  deleteChatCheckpoints: 'workbench-app:git:delete-chat-checkpoints',
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

/**
 * 聊天回溯的工作区检查点：每轮开跑前把项目工作树拍成一个 git 影子提交（私有 ref
 * `refs/velaros/checkpoints/<session>/<id>`，隔离 index，不碰用户的分支 / HEAD / index / stash）。
 */
export interface WorkbenchChatCheckpointCaptureRequest extends WorkbenchGitRootRequest {
  sessionId: string
  checkpointId: string
  label?: string
}

/** `commitId` 为 null：项目不是 git 仓库或捕获失败——这一轮只能回溯对话，不能回退文件。 */
export interface WorkbenchChatCheckpointCaptureResult {
  commitId: string | null
}

export interface WorkbenchChatCheckpointRestoreRequest extends WorkbenchGitRootRequest {
  commitId: string
}

/** 还原的**实际结果**：失败也要能如实写进回溯说明，所以不抛错。 */
export interface WorkbenchChatCheckpointRestoreResult {
  restored: boolean
  error: string | null
}

export interface WorkbenchChatCheckpointDeleteRequest extends WorkbenchGitRootRequest {
  sessionId: string
  checkpointIds: string[]
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
  captureChatCheckpoint(
    request: WorkbenchChatCheckpointCaptureRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchChatCheckpointCaptureResult>>
  restoreChatCheckpoint(
    request: WorkbenchChatCheckpointRestoreRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchChatCheckpointRestoreResult>>
  deleteChatCheckpoints(
    request: WorkbenchChatCheckpointDeleteRequest
  ): Promise<WorkbenchFsCallResult<void>>
}
