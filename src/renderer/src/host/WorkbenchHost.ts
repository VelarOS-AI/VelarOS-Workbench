import { AppError } from '@velaros-ai/core/error'
import type { Result } from '@velaros-ai/core/result'

import type {
  AppLocale,
  ListProviderModelsRequest,
  ProviderModelCatalog,
  SystemLocalAttachmentFileRequest,
  SystemLocalAttachmentFileResult,
  SystemLocalAttachmentFileWriteRequest,
  SystemLocalAttachmentFileWriteResult,
  SystemOpenPathOptions,
  SystemOpenPathResult,
  SystemOverview,
  SystemWorkspaceGitActionRequest,
  SystemWorkspaceGitActionResult,
  SystemWorkspaceGitBlameResult,
  SystemWorkspaceGitCommitMessageResult,
  SystemWorkspaceGitCommitResult,
  SystemWorkspaceGitCreateBranchResult,
  SystemWorkspaceGitDiffResult,
  SystemWorkspaceGitFileActionRequest,
  SystemWorkspaceGitFileActionResult,
  SystemWorkspaceGitFileAtCommitResult,
  SystemWorkspaceGitHunkActionResult,
  SystemWorkspaceGitInitializeRepositoryResult,
  SystemWorkspaceGitLineStatsSnapshot,
  SystemWorkspaceGitLogResult,
  SystemWorkspaceGitOperationResult,
  SystemWorkspaceGitStashActionResult,
  SystemWorkspaceGitStashListResult,
  SystemWorkspaceGitStashResult,
  SystemWorkspaceGitSummary,
  SystemWorkspaceGitSwitchBranchResult,
  SystemWorkspaceRootAddOptions,
  SystemWorkspaceRootScope,
  WorkbenchCancelSearchContentRequest,
  WorkbenchCopyEntryRequest,
  WorkbenchCreateEntryRequest,
  WorkbenchDeleteEntryRequest,
  WorkbenchDeleteEntryResult,
  WorkbenchEntryMutationResult,
  WorkbenchFindExistingFilesRequest,
  WorkbenchFindExistingFilesResult,
  WorkbenchIndexProjectRequest,
  WorkbenchIndexProjectResult,
  WorkbenchInlineCompletionRequest,
  WorkbenchInlineCompletionResult,
  WorkbenchInspectDeleteEntryRequest,
  WorkbenchInspectDeleteEntryResult,
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceCodeActionsResult,
  WorkbenchLanguageServiceCompletionResolveRequest,
  WorkbenchLanguageServiceCompletionResolveResult,
  WorkbenchLanguageServiceCompletionResult,
  WorkbenchLanguageServiceDefinitionResult,
  WorkbenchLanguageServiceDiagnosticsResult,
  WorkbenchLanguageServiceDocumentHighlightsResult,
  WorkbenchLanguageServiceDocumentSymbolsResult,
  WorkbenchLanguageServiceExtensionRequest,
  WorkbenchLanguageServiceExtensionResult,
  WorkbenchLanguageServiceFormatResult,
  WorkbenchLanguageServiceHoverQueryResult,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServiceInlayHintsResult,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceProjectDiagnosticsRequest,
  WorkbenchLanguageServiceProjectDiagnosticsResult,
  WorkbenchLanguageServiceReferencesResult,
  WorkbenchLanguageServiceRenameRequest,
  WorkbenchLanguageServiceRenameResult,
  WorkbenchLanguageServiceRequest,
  WorkbenchLanguageServiceSemanticTokensResult,
  WorkbenchLanguageServiceSignatureHelpQueryResult,
  WorkbenchListDirectoryRequest,
  WorkbenchListDirectoryResult,
  WorkbenchListLocalHistoryRequest,
  WorkbenchListLocalHistoryResult,
  WorkbenchListProjectFilesRequest,
  WorkbenchListProjectFilesResult,
  WorkbenchMoveEntryRequest,
  WorkbenchMoveEntryResult,
  WorkbenchProjectAiRulesRequest,
  WorkbenchProjectAiRulesResult,
  WorkbenchReadFileRequest,
  WorkbenchReadFileResult,
  WorkbenchReadImageFileRequest,
  WorkbenchReadImageFileResult,
  WorkbenchReadLocalHistorySnapshotRequest,
  WorkbenchReadLocalHistorySnapshotResult,
  WorkbenchRenameEntryRequest,
  WorkbenchReplaceContentRequest,
  WorkbenchReplaceContentResult,
  WorkbenchRestoreDeletedEntryRequest,
  WorkbenchRestoreDeletedEntryResult,
  WorkbenchRestoreMissingFileRequest,
  WorkbenchRunCommandOutputEvent,
  WorkbenchRunCommandRequest,
  WorkbenchRunCommandResult,
  WorkbenchSaveFileRequest,
  WorkbenchSaveFileResult,
  WorkbenchSearchContentProgressEvent,
  WorkbenchSearchContentRequest,
  WorkbenchSearchContentResult,
  WorkbenchSearchEntriesRequest,
  WorkbenchSearchEntriesResult,
  WorkbenchTerminalAcknowledgeRequest,
  WorkbenchTerminalCwdRequest,
  WorkbenchTerminalCwdResult,
  WorkbenchTerminalInputRequest,
  WorkbenchTerminalOutputEvent,
  WorkbenchTerminalResizeRequest,
  WorkbenchTerminalStartRequest,
  WorkbenchTerminalStartResult,
  WorkbenchTerminalStopRequest,
  WorkspaceGitDiffOptions,
  WorkspaceGitHunkActionOptions,
  WorkspaceGitLogOptions,
  WorkspaceGitOperationRequest,
  WorkspaceGitStashAction,
  WorkspaceGitStashOptions,
} from '@shared/contracts'
import type {
  WorkbenchGitBlameRequest,
  WorkbenchGitCancelRemoteActionResult,
} from '@shared/workbenchGit'

/** Workbench 所需的项目、编辑器、终端与代码智能 Kernel 能力。 */
export interface WorkbenchProjectKernelPort {
  listWorkbenchDirectory(
    request: WorkbenchListDirectoryRequest
  ): Promise<Result<WorkbenchListDirectoryResult>>
  readWorkbenchFile(request: WorkbenchReadFileRequest): Promise<Result<WorkbenchReadFileResult>>
  readWorkbenchImageFile(
    request: WorkbenchReadImageFileRequest
  ): Promise<Result<WorkbenchReadImageFileResult>>
  findExistingWorkbenchFiles(
    request: WorkbenchFindExistingFilesRequest
  ): Promise<Result<WorkbenchFindExistingFilesResult>>
  indexWorkbenchProject(
    request: WorkbenchIndexProjectRequest
  ): Promise<Result<WorkbenchIndexProjectResult>>
  getWorkbenchProjectAiRules(
    request: WorkbenchProjectAiRulesRequest
  ): Promise<Result<WorkbenchProjectAiRulesResult>>
  saveWorkbenchFile(request: WorkbenchSaveFileRequest): Promise<Result<WorkbenchSaveFileResult>>
  saveWorkbenchFileSync(request: WorkbenchSaveFileRequest): Result<WorkbenchSaveFileResult>
  listWorkbenchLocalHistory(
    request: WorkbenchListLocalHistoryRequest
  ): Promise<Result<WorkbenchListLocalHistoryResult>>
  readWorkbenchLocalHistorySnapshot(
    request: WorkbenchReadLocalHistorySnapshotRequest
  ): Promise<Result<WorkbenchReadLocalHistorySnapshotResult>>
  createWorkbenchEntry(
    request: WorkbenchCreateEntryRequest
  ): Promise<Result<WorkbenchEntryMutationResult>>
  renameWorkbenchEntry(
    request: WorkbenchRenameEntryRequest
  ): Promise<Result<WorkbenchEntryMutationResult>>
  moveWorkbenchEntry(request: WorkbenchMoveEntryRequest): Promise<Result<WorkbenchMoveEntryResult>>
  copyWorkbenchEntry(
    request: WorkbenchCopyEntryRequest
  ): Promise<Result<WorkbenchEntryMutationResult>>
  inspectWorkbenchDeleteEntry(
    request: WorkbenchInspectDeleteEntryRequest
  ): Promise<Result<WorkbenchInspectDeleteEntryResult>>
  deleteWorkbenchEntry(
    request: WorkbenchDeleteEntryRequest
  ): Promise<Result<WorkbenchDeleteEntryResult>>
  restoreDeletedWorkbenchEntry(
    request: WorkbenchRestoreDeletedEntryRequest
  ): Promise<Result<WorkbenchRestoreDeletedEntryResult>>
  restoreMissingWorkbenchFile(
    request: WorkbenchRestoreMissingFileRequest
  ): Promise<Result<WorkbenchSaveFileResult>>
  searchWorkbenchEntries(
    request: WorkbenchSearchEntriesRequest
  ): Promise<Result<WorkbenchSearchEntriesResult>>
  searchWorkbenchContent(
    request: WorkbenchSearchContentRequest
  ): Promise<Result<WorkbenchSearchContentResult>>
  cancelWorkbenchContentSearch(request: WorkbenchCancelSearchContentRequest): Promise<Result<void>>
  replaceWorkbenchContent(
    request: WorkbenchReplaceContentRequest
  ): Promise<Result<WorkbenchReplaceContentResult>>
  /** 带 searchId 的内容搜索边搜边推送的结果。 */
  onWorkbenchContentSearchProgress(
    listener: (event: WorkbenchSearchContentProgressEvent) => void
  ): () => void
  /** 快速打开按文件名找文件用的整份文件清单。 */
  listWorkbenchProjectFiles(
    request: WorkbenchListProjectFilesRequest
  ): Promise<Result<WorkbenchListProjectFilesResult>>
  getWorkbenchLanguageServiceDefinition(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceDefinitionResult>>
  getWorkbenchLanguageServiceCompletions(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceCompletionResult>>
  resolveWorkbenchLanguageServiceCompletion(
    request: WorkbenchLanguageServiceCompletionResolveRequest
  ): Promise<Result<WorkbenchLanguageServiceCompletionResolveResult>>
  getWorkbenchLanguageServiceDiagnostics(
    request: WorkbenchLanguageServiceRequest
  ): Promise<Result<WorkbenchLanguageServiceDiagnosticsResult>>
  getWorkbenchLanguageServiceProjectDiagnostics(
    request: WorkbenchLanguageServiceProjectDiagnosticsRequest
  ): Promise<Result<WorkbenchLanguageServiceProjectDiagnosticsResult>>
  getWorkbenchLanguageServiceRename(
    request: WorkbenchLanguageServiceRenameRequest
  ): Promise<Result<WorkbenchLanguageServiceRenameResult>>
  getWorkbenchLanguageServiceHover(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceHoverQueryResult>>
  getWorkbenchLanguageServiceReferences(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceReferencesResult>>
  getWorkbenchLanguageServiceSignatureHelp(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceSignatureHelpQueryResult>>
  getWorkbenchLanguageServiceFormat(
    request: WorkbenchLanguageServiceRequest
  ): Promise<Result<WorkbenchLanguageServiceFormatResult>>
  getWorkbenchLanguageServiceDocumentSymbols(
    request: WorkbenchLanguageServiceRequest
  ): Promise<Result<WorkbenchLanguageServiceDocumentSymbolsResult>>
  getWorkbenchLanguageServiceDocumentHighlights(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceDocumentHighlightsResult>>
  getWorkbenchLanguageServiceInlayHints(
    request: WorkbenchLanguageServiceInlayHintsRequest
  ): Promise<Result<WorkbenchLanguageServiceInlayHintsResult>>
  getWorkbenchLanguageServiceSemanticTokens(
    request: WorkbenchLanguageServiceRequest
  ): Promise<Result<WorkbenchLanguageServiceSemanticTokensResult>>
  getWorkbenchLanguageServiceCodeActions(
    request: WorkbenchLanguageServiceCodeActionsRequest
  ): Promise<Result<WorkbenchLanguageServiceCodeActionsResult>>
  requestWorkbenchLanguageServiceExtension(
    request: WorkbenchLanguageServiceExtensionRequest
  ): Promise<Result<WorkbenchLanguageServiceExtensionResult>>
  runWorkbenchCommand(
    request: WorkbenchRunCommandRequest
  ): Promise<Result<WorkbenchRunCommandResult>>
  onWorkbenchRunCommandOutput(listener: (event: WorkbenchRunCommandOutputEvent) => void): () => void
  startWorkbenchTerminalSession(
    request: WorkbenchTerminalStartRequest
  ): Promise<Result<WorkbenchTerminalStartResult>>
  writeWorkbenchTerminalInput(request: WorkbenchTerminalInputRequest): Promise<Result<void>>
  resizeWorkbenchTerminalSession(request: WorkbenchTerminalResizeRequest): Promise<Result<void>>
  stopWorkbenchTerminalSession(request: WorkbenchTerminalStopRequest): Promise<Result<void>>
  /** 终端会话的 shell 此刻所在的目录；问不到时 `cwd` 为 null。 */
  readWorkbenchTerminalCwd(
    request: WorkbenchTerminalCwdRequest
  ): Promise<Result<WorkbenchTerminalCwdResult>>
  getWorkbenchInlineCompletion(
    request: WorkbenchInlineCompletionRequest
  ): Promise<Result<WorkbenchInlineCompletionResult>>
  onWorkbenchTerminalOutput(listener: (event: WorkbenchTerminalOutputEvent) => void): () => void
  /** 一段伪终端输出已经写进 xterm（流控：主进程据此决定暂停还是继续读伪终端）。 */
  acknowledgeWorkbenchTerminalOutput(request: WorkbenchTerminalAcknowledgeRequest): void
}

/** Workbench 使用的 Kernel 会话与附件能力。 */
export interface WorkbenchSessionKernelPort {
  readLocalAttachmentFile(
    request: SystemLocalAttachmentFileRequest
  ): Promise<Result<SystemLocalAttachmentFileResult>>
  writeLocalAttachmentFile(
    request: SystemLocalAttachmentFileWriteRequest
  ): Promise<Result<SystemLocalAttachmentFileWriteResult>>
}

export interface WorkbenchSettingsKernelPort {
  listProviderModels(request: ListProviderModelsRequest): Promise<Result<ProviderModelCatalog>>
}

/** Workbench 使用的共享 workspace 与 Git Kernel 能力。 */
export interface WorkbenchWorkspaceKernelPort {
  openPath(
    sessionId: string,
    path: string,
    options?: SystemOpenPathOptions
  ): Promise<Result<SystemOpenPathResult>>
  pickDirectory(): Promise<Result<Nullable<string>>>
  addWorkspaceRoot(
    sessionId: string,
    path: string,
    options?: SystemWorkspaceRootAddOptions
  ): Promise<Result<SystemOverview>>
  setActiveWorkspaceRoot(
    sessionId: string,
    path: string,
    scope?: SystemWorkspaceRootScope
  ): Promise<Result<SystemOverview>>
  getWorkspaceGitSummary(workspaceRoot: string): Promise<Result<SystemWorkspaceGitSummary>>
  getWorkspaceGitLineStats(
    workspaceRoot: string
  ): Promise<Result<SystemWorkspaceGitLineStatsSnapshot>>
  getWorkspaceGitDiff(
    workspaceRoot: string,
    options?: WorkspaceGitDiffOptions
  ): Promise<Result<SystemWorkspaceGitDiffResult>>
  getWorkspaceGitFileAtCommit(
    workspaceRoot: string,
    options: { commitSha: string; path: string }
  ): Promise<Result<SystemWorkspaceGitFileAtCommitResult>>
  getWorkspaceGitBlame(
    workspaceRoot: string,
    options: Omit<WorkbenchGitBlameRequest, 'workspaceRoot'>
  ): Promise<Result<SystemWorkspaceGitBlameResult>>
  getWorkspaceGitLog(
    workspaceRoot: string,
    options?: WorkspaceGitLogOptions
  ): Promise<Result<SystemWorkspaceGitLogResult>>
  generateWorkspaceGitCommitMessage(
    workspaceRoot: string,
    locale?: AppLocale,
    paths?: string[]
  ): Promise<Result<SystemWorkspaceGitCommitMessageResult>>
  commitWorkspaceGitChanges(
    workspaceRoot: string,
    locale?: AppLocale,
    message?: string,
    paths?: string[]
  ): Promise<Result<SystemWorkspaceGitCommitResult>>
  /** 提交暂存区里的改动（它们在暂存区里的样子）。 */
  commitWorkspaceGitStagedChanges(
    workspaceRoot: string,
    locale?: AppLocale,
    message?: string
  ): Promise<Result<SystemWorkspaceGitCommitResult>>
  performWorkspaceGitFileAction(
    workspaceRoot: string,
    paths: string[],
    action: SystemWorkspaceGitFileActionRequest['action']
  ): Promise<Result<SystemWorkspaceGitFileActionResult>>
  /** 按块暂存、取消暂存、回滚一个文件里的几块改动。 */
  performWorkspaceGitHunkAction(
    workspaceRoot: string,
    options: WorkspaceGitHunkActionOptions
  ): Promise<Result<SystemWorkspaceGitHunkActionResult>>
  initializeWorkspaceGitRepository(
    workspaceRoot: string
  ): Promise<Result<SystemWorkspaceGitInitializeRepositoryResult>>
  switchWorkspaceGitBranch(
    workspaceRoot: string,
    branch: string,
    locale?: AppLocale,
    options?: { create?: boolean; startPoint?: string }
  ): Promise<Result<SystemWorkspaceGitSwitchBranchResult>>
  createWorkspaceGitBranch(
    workspaceRoot: string,
    branch: string
  ): Promise<Result<SystemWorkspaceGitCreateBranchResult>>
  performWorkspaceGitAction(
    workspaceRoot: string,
    action: SystemWorkspaceGitActionRequest['action'],
    options?: Pick<
      SystemWorkspaceGitActionRequest,
      'branch' | 'githubToken' | 'privateKeyPath' | 'sshKeyPath' | 'operationId'
    >
  ): Promise<Result<SystemWorkspaceGitActionResult>>
  /** 取消一个带着 `operationId` 发起的远端操作；它已经结束时 `cancelled` 为 false。 */
  cancelWorkspaceGitAction(
    operationId: string
  ): Promise<Result<WorkbenchGitCancelRemoteActionResult>>
  /** 仓库里的贮藏，最新的在前。 */
  listWorkspaceGitStashes(
    workspaceRoot: string
  ): Promise<Result<SystemWorkspaceGitStashListResult>>
  /** 把项目里没提交的改动贮藏起来。 */
  stashWorkspaceGitChanges(
    workspaceRoot: string,
    options?: WorkspaceGitStashOptions
  ): Promise<Result<SystemWorkspaceGitStashResult>>
  /** 取回（apply / pop）或删掉（drop）一条贮藏，凭贮藏提交的对象名。 */
  performWorkspaceGitStashAction(
    workspaceRoot: string,
    sha: string,
    action: WorkspaceGitStashAction
  ): Promise<Result<SystemWorkspaceGitStashActionResult>>
  /**
   * 合并、变基、拣选、撤销，或者继续、放弃、跳过进行到一半的那个。出了冲突不算失败：结果里列出冲突
   * 文件，操作停在那里（摘要里的 `operation`）。
   */
  performWorkspaceGitOperation(
    workspaceRoot: string,
    request: WorkspaceGitOperationRequest
  ): Promise<Result<SystemWorkspaceGitOperationResult>>
}

export interface WorkbenchKernelPort {
  project: WorkbenchProjectKernelPort
  sessions: WorkbenchSessionKernelPort
  settings: WorkbenchSettingsKernelPort
  workspace: WorkbenchWorkspaceKernelPort
}

export interface WorkbenchOpenSettingsWindowRequest {
  tab?: string
  focus?: string
  request?: number
}

/** Workbench 仍需宿主提供的窗口和系统集成；这些能力不属于 Kernel core。 */
export interface WorkbenchShellPort {
  openChatWindow(): Promise<void>
  openSettingsWindow(request?: WorkbenchOpenSettingsWindowRequest): Promise<void>
}

export interface WorkbenchHost {
  kernel: WorkbenchKernelPort
  shell: WorkbenchShellPort
}

/**
 * Owns the host adapter installed at one Workbench composition root.
 *
 * A dedicated runtime can be instantiated by tests or multi-surface hosts. Package components use
 * the exported default instance for backward compatibility.
 */
export class WorkbenchHostRuntime {
  private installedHost: Nullable<WorkbenchHost> = null

  public constructor(host?: WorkbenchHost) {
    if (host) this.install(host)
  }

  public get isInstalled(): boolean {
    return this.installedHost !== null
  }

  public get kernel(): WorkbenchKernelPort {
    return this.requireHost().kernel
  }

  public get shell(): WorkbenchShellPort {
    return this.requireHost().shell
  }

  public install(host: WorkbenchHost): void {
    if (!host?.kernel || !host.shell) {
      throw new AppError('INVALID_ARGUMENT', 'Workbench host must provide kernel and shell ports')
    }
    this.installedHost = host
  }

  /**
   * Removes the current adapter. Supplying `expectedHost` avoids an older composition root
   * uninstalling a newer adapter during asynchronous teardown.
   */
  public uninstall(expectedHost?: WorkbenchHost): boolean {
    if (!this.installedHost) return false
    if (expectedHost && this.installedHost !== expectedHost) return false
    this.installedHost = null
    return true
  }

  /** Composition-root 生命周期的统一别名。 */
  public dispose(): void {
    this.uninstall()
  }

  private requireHost(): WorkbenchHost {
    if (!this.installedHost) {
      throw new AppError('INVARIANT', 'Workbench host is not installed')
    }
    return this.installedHost
  }
}

/**
 * Default application-level host runtime used by Workbench components and controllers.
 */
export const workbenchHost = new WorkbenchHostRuntime()

/** 由产品入口安装具体适配器。Desktop、未来的独立 Workbench 应用可以提供不同实现。 */
export function installWorkbenchHost(host: WorkbenchHost): void {
  workbenchHost.install(host)
}

/**
 * 卸载宿主适配器。`expectedHost` 可防止旧入口销毁时误卸载较新的安装。
 */
export function uninstallWorkbenchHost(expectedHost?: WorkbenchHost): boolean {
  return workbenchHost.uninstall(expectedHost)
}
