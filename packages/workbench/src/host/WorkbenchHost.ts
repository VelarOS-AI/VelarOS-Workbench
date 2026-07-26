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
  WorkbenchInstallLanguageGrammarRequest,
  WorkbenchLanguageGrammarCatalog,
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
} from '../contracts/index'

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
  deleteWorkbenchEntry(
    request: WorkbenchDeleteEntryRequest
  ): Promise<Result<WorkbenchDeleteEntryResult>>
  restoreDeletedWorkbenchEntry(
    request: WorkbenchRestoreDeletedEntryRequest
  ): Promise<Result<WorkbenchRestoreDeletedEntryResult>>
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
  listWorkbenchLanguageGrammars(): Promise<Result<WorkbenchLanguageGrammarCatalog>>
  installWorkbenchLanguageGrammar(
    request: WorkbenchInstallLanguageGrammarRequest
  ): Promise<Result<WorkbenchLanguageGrammarCatalog>>
  onWorkbenchLanguageGrammarsChanged(
    listener: (catalog: WorkbenchLanguageGrammarCatalog) => void
  ): () => void
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

let installedWorkbenchHost: Nullable<WorkbenchHost> = null

function requireWorkbenchHost(): WorkbenchHost {
  if (!installedWorkbenchHost) {
    throw new AppError('INVARIANT', 'Workbench host is not installed')
  }

  return installedWorkbenchHost
}

/** 由产品入口安装具体适配器。Desktop、未来的独立 Workbench 应用可以提供不同实现。 */
export function installWorkbenchHost(host: WorkbenchHost): void {
  installedWorkbenchHost = host
}

/**
 * Workbench 内部唯一允许访问的宿主入口。
 * getter 保证模块加载阶段不读取宿主，测试与独立入口可在实际调用前完成安装。
 */
export const workbenchHost = {
  get kernel(): WorkbenchKernelPort {
    return requireWorkbenchHost().kernel
  },
  get shell(): WorkbenchShellPort {
    return requireWorkbenchHost().shell
  },
}
