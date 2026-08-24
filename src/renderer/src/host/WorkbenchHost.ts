import { AppError } from '@velaros-ai/core/error'
import type { Result } from '@velaros-ai/core/result'

import type {
  AppLocale,
  ChatLoadOlderMessagesRequest,
  ChatLoadOlderMessagesResponse,
  ListProviderModelsRequest,
  ProviderModelCatalog,
  SystemFileChangePreviewResult,
  SystemLocalAttachmentFileRequest,
  SystemLocalAttachmentFileResult,
  SystemLocalAttachmentFileWriteRequest,
  SystemLocalAttachmentFileWriteResult,
  SystemOpenPathOptions,
  SystemOpenPathResult,
  SystemOverview,
  SystemRestoreFileChangeResult,
  SystemRollbackFileChangeResult,
  SystemWorkspaceGitActionRequest,
  SystemWorkspaceGitActionResult,
  SystemWorkspaceGitCommitMessageResult,
  SystemWorkspaceGitCommitResult,
  SystemWorkspaceGitCreateBranchResult,
  SystemWorkspaceGitDiffResult,
  SystemWorkspaceGitFileActionRequest,
  SystemWorkspaceGitFileActionResult,
  SystemWorkspaceGitFileAtCommitResult,
  SystemWorkspaceGitInitializeRepositoryResult,
  SystemWorkspaceGitLineStatsSnapshot,
  SystemWorkspaceGitLogResult,
  SystemWorkspaceGitSummary,
  SystemWorkspaceGitSwitchBranchResult,
  SystemWorkspaceRootAddOptions,
  SystemWorkspaceRootScope,
  WorkbenchCreateEntryRequest,
  WorkbenchDeleteEntryRequest,
  WorkbenchDeleteEntryResult,
  WorkbenchEditorCommandEvent,
  WorkbenchEditorCommandResult,
  WorkbenchEntryMutationResult,
  WorkbenchGetCodeGraphRequest,
  WorkbenchGetCodeGraphResult,
  WorkbenchIndexProjectRequest,
  WorkbenchIndexProjectResult,
  WorkbenchInlineCompletionRequest,
  WorkbenchInlineCompletionResult,
  WorkbenchInspectDeleteEntryRequest,
  WorkbenchInspectDeleteEntryResult,
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceCodeActionsResult,
  WorkbenchLanguageServiceCompletionResult,
  WorkbenchLanguageServiceDefinitionResult,
  WorkbenchLanguageServiceDiagnosticsResult,
  WorkbenchLanguageServiceDocumentHighlightsResult,
  WorkbenchLanguageServiceDocumentSymbolsResult,
  WorkbenchLanguageServiceFormatResult,
  WorkbenchLanguageServiceHoverQueryResult,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServiceInlayHintsResult,
  WorkbenchLanguageServicePositionRequest,
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
  WorkbenchMoveEntryRequest,
  WorkbenchMoveEntryResult,
  WorkbenchProjectAiIndexStatus,
  WorkbenchProjectAiIndexStatusChangedEvent,
  WorkbenchProjectAiIndexStatusRequest,
  WorkbenchProjectAiRulesRequest,
  WorkbenchProjectAiRulesResult,
  WorkbenchReadFileRequest,
  WorkbenchReadFileResult,
  WorkbenchReadLocalHistorySnapshotRequest,
  WorkbenchReadLocalHistorySnapshotResult,
  WorkbenchRenameEntryRequest,
  WorkbenchReportAgentWorkspaceSignalsRequest,
  WorkbenchRestoreDeletedEntryRequest,
  WorkbenchRestoreDeletedEntryResult,
  WorkbenchRestoreMissingFileRequest,
  WorkbenchRunCommandOutputEvent,
  WorkbenchRunCommandRequest,
  WorkbenchRunCommandResult,
  WorkbenchSaveFileRequest,
  WorkbenchSaveFileResult,
  WorkbenchSearchContentRequest,
  WorkbenchSearchContentResult,
  WorkbenchSearchEntriesRequest,
  WorkbenchSearchEntriesResult,
  WorkbenchStartProjectAiIndexRequest,
  WorkbenchStartProjectAiIndexResult,
  WorkbenchTerminalInputRequest,
  WorkbenchTerminalOutputEvent,
  WorkbenchTerminalStartRequest,
  WorkbenchTerminalStartResult,
  WorkbenchTerminalStopRequest,
  WorkspaceGitDiffOptions,
  WorkspaceGitLogOptions,
} from '@shared/contracts'

/** Workbench 所需的项目、编辑器、终端与代码智能 Kernel 能力。 */
export interface WorkbenchProjectKernelPort {
  listWorkbenchDirectory(
    request: WorkbenchListDirectoryRequest
  ): Promise<Result<WorkbenchListDirectoryResult>>
  readWorkbenchFile(request: WorkbenchReadFileRequest): Promise<Result<WorkbenchReadFileResult>>
  indexWorkbenchProject(
    request: WorkbenchIndexProjectRequest
  ): Promise<Result<WorkbenchIndexProjectResult>>
  startWorkbenchProjectAiIndex(
    request: WorkbenchStartProjectAiIndexRequest
  ): Promise<Result<WorkbenchStartProjectAiIndexResult>>
  getWorkbenchProjectAiIndexStatus(
    request: WorkbenchProjectAiIndexStatusRequest
  ): Promise<Result<WorkbenchProjectAiIndexStatus>>
  getWorkbenchProjectAiRules(
    request: WorkbenchProjectAiRulesRequest
  ): Promise<Result<WorkbenchProjectAiRulesResult>>
  getWorkbenchCodeGraph(
    request: WorkbenchGetCodeGraphRequest
  ): Promise<Result<WorkbenchGetCodeGraphResult>>
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
  getWorkbenchLanguageServiceDefinition(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceDefinitionResult>>
  getWorkbenchLanguageServiceCompletions(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<Result<WorkbenchLanguageServiceCompletionResult>>
  getWorkbenchLanguageServiceDiagnostics(
    request: WorkbenchLanguageServiceRequest
  ): Promise<Result<WorkbenchLanguageServiceDiagnosticsResult>>
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
  runWorkbenchCommand(
    request: WorkbenchRunCommandRequest
  ): Promise<Result<WorkbenchRunCommandResult>>
  onWorkbenchRunCommandOutput(listener: (event: WorkbenchRunCommandOutputEvent) => void): () => void
  startWorkbenchTerminalSession(
    request: WorkbenchTerminalStartRequest
  ): Promise<Result<WorkbenchTerminalStartResult>>
  writeWorkbenchTerminalInput(request: WorkbenchTerminalInputRequest): Promise<Result<void>>
  stopWorkbenchTerminalSession(request: WorkbenchTerminalStopRequest): Promise<Result<void>>
  reportWorkbenchAgentWorkspaceSignals(
    request: WorkbenchReportAgentWorkspaceSignalsRequest
  ): Promise<Result<void>>
  getWorkbenchInlineCompletion(
    request: WorkbenchInlineCompletionRequest
  ): Promise<Result<WorkbenchInlineCompletionResult>>
  onWorkbenchTerminalOutput(listener: (event: WorkbenchTerminalOutputEvent) => void): () => void
  onWorkbenchProjectAiIndexStatusChanged(
    listener: (event: WorkbenchProjectAiIndexStatusChangedEvent) => void
  ): () => void
  onWorkbenchEditorCommand(listener: (event: WorkbenchEditorCommandEvent) => void): () => void
  acknowledgeWorkbenchEditorCommand(result: WorkbenchEditorCommandResult): Promise<Result<void>>
}

/** Workbench 使用的 Kernel 会话与附件能力。 */
export interface WorkbenchSessionKernelPort {
  loadOlderMessages(
    request: ChatLoadOlderMessagesRequest
  ): Promise<Result<ChatLoadOlderMessagesResponse>>
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
  getFileChangePreview(
    sessionId: string,
    changeId: string,
    path?: string
  ): Promise<Result<SystemFileChangePreviewResult>>
  rollbackFileChange(
    sessionId: string,
    changeId: string,
    path?: string
  ): Promise<Result<SystemRollbackFileChangeResult>>
  restoreFileChange(
    sessionId: string,
    changeId: string,
    path?: string
  ): Promise<Result<SystemRestoreFileChangeResult>>
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
  performWorkspaceGitFileAction(
    workspaceRoot: string,
    path: string,
    action: SystemWorkspaceGitFileActionRequest['action']
  ): Promise<Result<SystemWorkspaceGitFileActionResult>>
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
    options?: Pick<SystemWorkspaceGitActionRequest, 'githubToken' | 'privateKeyPath' | 'sshKeyPath'>
  ): Promise<Result<SystemWorkspaceGitActionResult>>
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
