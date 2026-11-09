import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'

import { type SystemWorkspaceGitActionResult, type SystemWorkspaceGitBlameResult, type SystemWorkspaceGitCommitMessageResult, type SystemWorkspaceGitCommitResult, type SystemWorkspaceGitCreateBranchResult, type SystemWorkspaceGitDiffResult, type SystemWorkspaceGitFileActionResult, type SystemWorkspaceGitFileAtCommitResult, type SystemWorkspaceGitHunkActionResult, type SystemWorkspaceGitInitializeRepositoryResult, type SystemWorkspaceGitLineStatsSnapshot, type SystemWorkspaceGitLogResult, type SystemWorkspaceGitOperationResult, type SystemWorkspaceGitStashActionResult, type SystemWorkspaceGitStashListResult, type SystemWorkspaceGitStashResult, type SystemWorkspaceGitSummary, type SystemWorkspaceGitSwitchBranchResult, type WorkspaceGitDiffOptions, type WorkspaceGitFileAction, type WorkspaceGitFileStatusEntry, type WorkspaceGitLogOptions, type WorkspaceGitRemoteAction } from '@shared/contracts/system'
import { type WorkspaceGitHunkActionOptions, type WorkspaceGitOperationAction, type WorkspaceGitOperationKind, type WorkspaceGitOperationRequest, type WorkspaceGitRemoteActionOptions, type WorkspaceGitStashAction, type WorkspaceGitStashOptions } from '@shared/contracts/workspaceGit'

import type { WorkbenchFsCallResult } from './workbenchFs'
import type { WorkbenchTextEncoding, WorkbenchTextEol } from './workbenchTextFormat'

export const WorkbenchGitChannels = {
  summary: 'workbench-app:git:summary',
  lineStats: 'workbench-app:git:line-stats',
  diff: 'workbench-app:git:diff',
  fileAtCommit: 'workbench-app:git:file-at-commit',
  blame: 'workbench-app:git:blame',
  log: 'workbench-app:git:log',
  generateCommitMessage: 'workbench-app:git:generate-commit-message',
  commit: 'workbench-app:git:commit',
  fileAction: 'workbench-app:git:file-action',
  hunkAction: 'workbench-app:git:hunk-action',
  initialize: 'workbench-app:git:initialize',
  switchBranch: 'workbench-app:git:switch-branch',
  createBranch: 'workbench-app:git:create-branch',
  remoteAction: 'workbench-app:git:remote-action',
  cancelRemoteAction: 'workbench-app:git:cancel-remote-action',
  stashList: 'workbench-app:git:stash-list',
  stash: 'workbench-app:git:stash',
  stashAction: 'workbench-app:git:stash-action',
  operation: 'workbench-app:git:operation',
  captureChatCheckpoint: 'workbench-app:git:capture-chat-checkpoint',
  deleteChatCheckpoints: 'workbench-app:git:delete-chat-checkpoints',
  captureChatRunChanges: 'workbench-app:git:capture-chat-run-changes',
  readChatRunChanges: 'workbench-app:git:read-chat-run-changes',
  deleteChatRunChanges: 'workbench-app:git:delete-chat-run-changes',
  readChatRunChangeBaseFile: 'workbench-app:git:read-chat-run-change-base-file',
} as const

/** 未合并（冲突）的状态码组合，见 git status 文档「Unmerged」一节。 */
const UnmergedStatusPairs = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** 这个文件还有没解决的合并冲突：不能提交、不能回滚，只能解决后标记为已解决。 */
export function isWorkspaceGitConflictEntry(
  entry: Pick<WorkspaceGitFileStatusEntry, 'indexStatus' | 'workTreeStatus'>
): boolean {
  return UnmergedStatusPairs.has(`${entry.indexStatus}${entry.workTreeStatus}`)
}

/** 冲突标记：行首 7 个 `<` 或 `>`，后面是空格（分支名）或行尾。 */
const ConflictMarkerPattern = /^(?:<{7}|>{7})(?: |\r?$)/m

/** 正文里还留着冲突标记：这个文件的冲突还没解决完，不能标记为已解决。 */
export function hasWorkspaceGitConflictMarkers(text: string): boolean {
  return ConflictMarkerPattern.test(text)
}

export interface WorkbenchGitRootRequest {
  workspaceRoot: string
}

export interface WorkbenchGitDiffRequest extends WorkbenchGitRootRequest, WorkspaceGitDiffOptions {}

export interface WorkbenchGitFileAtCommitRequest extends WorkbenchGitRootRequest {
  commitSha: string
  path: string
}

/**
 * 查每一行最后是哪个提交改的。给了 `content`（编辑器里此刻的正文）就按它算，连同文件自己的编码与换行符一起给，
 * 这样没保存的改动、CRLF 或 GBK 文件都对得上行；没给就按磁盘上的文件。
 */
export interface WorkbenchGitBlameRequest extends WorkbenchGitRootRequest {
  path: string
  content?: string
  encoding?: WorkbenchTextEncoding
  eol?: WorkbenchTextEol
}

export interface WorkbenchGitLogRequest extends WorkbenchGitRootRequest, WorkspaceGitLogOptions {}

export interface WorkbenchGitCommitMessageRequest extends WorkbenchGitRootRequest {
  locale?: AppLocale
  paths?: string[]
}

export interface WorkbenchGitCommitRequest extends WorkbenchGitCommitMessageRequest {
  message?: string
  /** 提交暂存区里的改动（它们在暂存区里的样子），不看工作区；这时不能再给 `paths`。 */
  staged?: boolean
}

export interface WorkbenchGitFileActionRequest extends WorkbenchGitRootRequest {
  /** 至少一个，相对项目根。 */
  paths: string[]
  action: WorkspaceGitFileAction
}

export interface WorkbenchGitHunkActionRequest
  extends WorkbenchGitRootRequest,
    WorkspaceGitHunkActionOptions {}

export interface WorkbenchGitSwitchBranchRequest extends WorkbenchGitRootRequest {
  branch: string
  create?: boolean
  startPoint?: string
}

export interface WorkbenchGitCreateBranchRequest extends WorkbenchGitRootRequest {
  branch: string
}

export interface WorkbenchGitRemoteActionRequest
  extends WorkbenchGitRootRequest,
    WorkspaceGitRemoteActionOptions {
  action: WorkspaceGitRemoteAction
}

/** 取消一个正在跑的远端操作，凭发起时给的编号。 */
export interface WorkbenchGitCancelRemoteActionRequest {
  operationId: string
}

export interface WorkbenchGitCancelRemoteActionResult {
  /** false：没有这个编号的操作在跑（已经结束了）。 */
  cancelled: boolean
}

export interface WorkbenchGitStashRequest
  extends WorkbenchGitRootRequest,
    WorkspaceGitStashOptions {}

/** 取回或删掉一条贮藏，凭贮藏提交的对象名（不是 `stash@{n}`：序号会变）。 */
export interface WorkbenchGitStashActionRequest extends WorkbenchGitRootRequest {
  sha: string
  action: WorkspaceGitStashAction
}

/** 合并、变基、拣选、撤销，或者继续、放弃、跳过进行到一半的那个。 */
export interface WorkbenchGitOperationRequest
  extends WorkbenchGitRootRequest,
    WorkspaceGitOperationRequest {}

const GitOperationKinds: ReadonlySet<string> = new Set(['merge', 'rebase', 'cherry-pick', 'revert'])
const GitOperationSteps: ReadonlySet<string> = new Set(['continue', 'abort', 'skip'])

/**
 * 操作的种类，也就是「开始一个操作」的那几个动作（要给出对象）；其余的动作（继续、放弃、跳过）是对
 * 进行到一半的那个操作说的。
 */
export function isWorkspaceGitOperationKind(value: unknown): value is WorkspaceGitOperationKind {
  return typeof value === 'string' && GitOperationKinds.has(value)
}

export function isWorkspaceGitOperationAction(value: unknown): value is WorkspaceGitOperationAction {
  return (
    isWorkspaceGitOperationKind(value) || (typeof value === 'string' && GitOperationSteps.has(value))
  )
}

/**
 * 聊天回溯的工作区检查点：每轮开跑前把项目工作树拍成一个 git 影子提交（私有 ref
 * `refs/velaros/checkpoints/<session>/<id>`，隔离 index，不碰用户的分支 / HEAD / index / stash）。
 * 拍检查点的同时主进程为这一轮开一本改动归属账本（检查点 id 就是这一轮的记录 id）。
 */
export interface WorkbenchChatCheckpointCaptureRequest extends WorkbenchGitRootRequest {
  sessionId: string
  checkpointId: string
  label?: string
}

/** `commitId` 为 null：项目不是 git 仓库或捕获失败——这一轮没有「本轮改动」可比。 */
export interface WorkbenchChatCheckpointCaptureResult {
  commitId: string | null
}

export interface WorkbenchChatCheckpointDeleteRequest extends WorkbenchGitRootRequest {
  sessionId: string
  checkpointIds: string[]
}

/**
 * 每轮的「本轮改动」（Desktop 运行标记上的 workspaceCheckpointDiff）：拿工作树与这一轮开跑前的检查点
 * 做 diff，再按这一轮的改动归属只留 Agent 改过的文件——运行期间用户在编辑器、终端里的改动，别的程序、
 * 别的会话写的文件都不算这一轮的。运行中每有写入就采一次（「AI 改动」面板实时刷新），收尾时再采一次
 * 最终的，同一个 recordId 覆盖同一条记录。补丁全文写进主进程数据区的记录文件——会话历史存在
 * localStorage，放不下补丁——运行标记上只留定长摘要，卡片挂出来时再按 recordId 读记录。
 */
export interface WorkbenchChatRunChangesCaptureRequest extends WorkbenchGitRootRequest {
  sessionId: string
  /** 记录 id（这一轮检查点的 id），会话内唯一；这一轮的每次采集都用它。 */
  recordId: string
  /** 这一轮开跑前检查点的影子提交：diff 的起点。 */
  baseCommitId: string
  /** 收尾时的最终采集：等最后一条命令的余量走完再拍工作树，采完关掉这一轮的归属账本。 */
  final?: boolean
}

/** 记在运行标记上的摘要：定长，不随改动文件数增长。 */
export interface WorkbenchChatRunChangesSummary {
  recordId: string
  /** 这次采集的时刻，也是记录文件的版本：同一条记录被重新采集后，读过的旧内容按它作废。 */
  capturedAt: number
  fileCount: number
  additions: number
  deletions: number
  /** 采集失败的原因；成功（包括这一轮没改文件）为 null。 */
  error: string | null
}

export type WorkbenchChatRunFileChangeStatus = 'added' | 'deleted' | 'modified'

/**
 * 一个文件改动的归属：`agent` 只有 Agent 动过；`mixed` 这一轮里 AI 之外（用户、别的程序、别的会话）
 * 也动过它——差异里混着两边的改动，回溯时不回退它。
 */
export type WorkbenchChatRunFileAttribution = 'agent' | 'mixed'

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
  /** 归属；早于改动归属的旧记录没有它，整轮都按 Agent 的算。 */
  attribution?: WorkbenchChatRunFileAttribution
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
  getBlame(
    request: WorkbenchGitBlameRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitBlameResult>>
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
  performHunkAction(
    request: WorkbenchGitHunkActionRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitHunkActionResult>>
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
  cancelRemoteAction(
    request: WorkbenchGitCancelRemoteActionRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchGitCancelRemoteActionResult>>
  listStashes(
    request: WorkbenchGitRootRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitStashListResult>>
  stash(
    request: WorkbenchGitStashRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitStashResult>>
  performStashAction(
    request: WorkbenchGitStashActionRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitStashActionResult>>
  performOperation(
    request: WorkbenchGitOperationRequest
  ): Promise<WorkbenchFsCallResult<SystemWorkspaceGitOperationResult>>
  captureChatCheckpoint(
    request: WorkbenchChatCheckpointCaptureRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchChatCheckpointCaptureResult>>
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
