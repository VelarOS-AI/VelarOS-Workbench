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
  captureChatRunChanges: 'workbench-app:git:capture-chat-run-changes',
  readChatRunChanges: 'workbench-app:git:read-chat-run-changes',
  deleteChatRunChanges: 'workbench-app:git:delete-chat-run-changes',
  readChatRunChangeBaseFile: 'workbench-app:git:read-chat-run-change-base-file',
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

/**
 * 每轮的「本轮改动」（Desktop 运行标记上的 workspaceCheckpointDiff）：一轮正常收尾后，拿工作树与
 * 这一轮开跑前的检查点做 diff。补丁全文写进主进程数据区的记录文件——会话历史存在 localStorage，
 * 放不下补丁——运行标记上只留定长摘要，卡片挂出来时再按 recordId 读记录。
 */
export interface WorkbenchChatRunChangesCaptureRequest extends WorkbenchGitRootRequest {
  sessionId: string
  /** 记录 id（这一轮检查点的 id），会话内唯一。 */
  recordId: string
  /** 这一轮开跑前检查点的影子提交：diff 的起点。 */
  baseCommitId: string
}

/** 记在运行标记上的摘要：定长，不随改动文件数增长。 */
export interface WorkbenchChatRunChangesSummary {
  recordId: string
  capturedAt: number
  fileCount: number
  additions: number
  deletions: number
  /** 采集失败的原因；成功（包括这一轮没改文件）为 null。 */
  error: string | null
}

export type WorkbenchChatRunFileChangeStatus = 'added' | 'deleted' | 'modified'

export interface WorkbenchChatRunFileChange {
  /** 相对项目根的路径。 */
  path: string
  status: WorkbenchChatRunFileChangeStatus
  additions: number
  deletions: number
  binary: boolean
  /** 单个文件的统一 diff；二进制或没存逐行补丁时为空串。 */
  patch: string
  /** 改动过大（行数、字节或文件数超限）没存逐行补丁；计数仍然准确。 */
  patchOmitted: boolean
}

export interface WorkbenchChatRunChangesRecord {
  recordId: string
  capturedAt: number
  /**
   * 这一轮开跑前检查点的影子提交：逐行补丁的起点，按它能读出文件改动前的全文。
   * 早于这个字段写下的记录没有它，只能看补丁本身。
   */
  baseCommitId?: string
  changes: WorkbenchChatRunFileChange[]
}

export interface WorkbenchChatRunChangesReadRequest extends WorkbenchGitRootRequest {
  sessionId: string
  recordId: string
}

/** 读一轮改动里某个文件改动前的全文（按记录里的起点提交）。 */
export interface WorkbenchChatRunChangeBaseFileRequest extends WorkbenchGitRootRequest {
  sessionId: string
  recordId: string
  /** 记录里的文件路径（相对项目根）。 */
  path: string
}

/**
 * `content` 为 null：没有全文可读——记录没有起点提交、这个文件是这一轮新建的、快照对象已被清理，
 * 或文件太大。查看器此时只显示补丁本身。
 */
export interface WorkbenchChatRunChangeBaseFileResult {
  content: string | null
}

export interface WorkbenchChatRunChangesDeleteRequest extends WorkbenchGitRootRequest {
  sessionId: string
  /** 省略时删掉这个会话的全部记录（会话被移除时）。 */
  recordIds?: string[]
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
  captureChatRunChanges(
    request: WorkbenchChatRunChangesCaptureRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchChatRunChangesSummary>>
  /** 记录不在（已清理或这一轮没改文件）时为 null。 */
  readChatRunChanges(
    request: WorkbenchChatRunChangesReadRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchChatRunChangesRecord | null>>
  readChatRunChangeBaseFile(
    request: WorkbenchChatRunChangeBaseFileRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchChatRunChangeBaseFileResult>>
  deleteChatRunChanges(
    request: WorkbenchChatRunChangesDeleteRequest
  ): Promise<WorkbenchFsCallResult<void>>
}
