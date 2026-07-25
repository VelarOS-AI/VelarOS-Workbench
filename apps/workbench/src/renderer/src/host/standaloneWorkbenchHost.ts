import { AppError, Result } from '@velaros-ai/core'
import type { Result as ResultType } from '@velaros-ai/core/result'
import { installWorkbenchHost, type WorkbenchHost } from '@velaros-ai/workbench/host'

import type { WorkbenchFsCallResult } from '../../../shared/workbenchFs'

/**
 * 独立 Workbench 应用的宿主适配器。
 *
 * Desktop 用 `installDesktopWorkbenchHost` 把 Workbench 产品端口接到 renderer IPC；独立应用
 * 把本地 IDE 端口接到自建 main 服务（经 `window.velarosWorkbenchFs` / `window.velarosWorkbenchLanguage`
 * / `window.velarosWorkbenchTerminal` 等桥）。已实装：目录列表 / 读写族 / 双搜索 /
 * 一次性命令运行（含流式输出订阅）/ 本地历史读 + 11 个语言服务动词（定义 / 补全 / 诊断 /
 * 重命名 / hover / 引用 / 签名帮助 / 格式化 / 文档符号 / 文档高亮 / inlay，由 main 的语言服务
 * worker 托管 tsserver）+ Git + 持久终端会话 + 文件监听 + 按需语法。
 *
 * 仍为「尚未连接」/ no-op 的动词按依赖归档：
 * - AI 补全（getWorkbenchInlineCompletion）/ AI 索引 / chat / flagged tasks — 归共享 Kernel RPC。
 * - 编辑器命令桥（onWorkbenchEditorCommand / acknowledge…）— 死件：独立应用无内嵌 agent，
 *   没有命令源，不复活。
 */
const StandaloneKernelNotConnectedMessage =
  'This Workbench capability requires a connected VelarOS Kernel.'

function notConnected<T>(): Promise<ResultType<T>> {
  return Promise.resolve(Result.fail(new AppError('UNKNOWN', StandaloneKernelNotConnectedMessage)))
}

/** main 侧错误信封 → 产品端口 Result：跨进程边界的一次性升格点（保留 AppError 语义码）。 */
function toHostResult<T>(envelope: WorkbenchFsCallResult<T>): ResultType<T> {
  return envelope.ok
    ? Result.ok(envelope.value)
    : Result.fail(new AppError(envelope.code ?? 'UNKNOWN', envelope.message))
}

function noopUnsubscribe(): void {}

const standaloneWorkbenchHost: WorkbenchHost = {
  kernel: {
    project: {
      listWorkbenchDirectory: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.listDirectory(request)),
      readWorkbenchFile: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.readFile(request)),
      indexWorkbenchProject: () => notConnected(),
      startWorkbenchProjectAiIndex: () => notConnected(),
      getWorkbenchProjectAiIndexStatus: () => notConnected(),
      getWorkbenchProjectAiRules: () => notConnected(),
      getWorkbenchCodeGraph: () => notConnected(),
      saveWorkbenchFile: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.saveFile(request)),
      saveWorkbenchFileSync: (request) =>
        toHostResult(window.velarosWorkbenchFs.saveFileSync(request)),
      listWorkbenchLocalHistory: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.listLocalHistory(request)),
      readWorkbenchLocalHistorySnapshot: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.readLocalHistorySnapshot(request)),
      createWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.createEntry(request)),
      renameWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.renameEntry(request)),
      moveWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.moveEntry(request)),
      deleteWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.deleteEntry(request)),
      restoreDeletedWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.restoreDeletedEntry(request)),
      searchWorkbenchEntries: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.searchEntries(request)),
      searchWorkbenchContent: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.searchContent(request)),
      getWorkbenchLanguageServiceDefinition: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getDefinition(request)),
      getWorkbenchLanguageServiceCompletions: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getCompletions(request)),
      getWorkbenchLanguageServiceDiagnostics: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getDiagnostics(request)),
      getWorkbenchLanguageServiceRename: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getRename(request)),
      getWorkbenchLanguageServiceHover: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getHover(request)),
      getWorkbenchLanguageServiceReferences: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getReferences(request)),
      getWorkbenchLanguageServiceSignatureHelp: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getSignatureHelp(request)),
      getWorkbenchLanguageServiceFormat: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getFormat(request)),
      getWorkbenchLanguageServiceDocumentSymbols: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getDocumentSymbols(request)),
      getWorkbenchLanguageServiceDocumentHighlights: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getDocumentHighlights(request)),
      getWorkbenchLanguageServiceInlayHints: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getInlayHints(request)),
      runWorkbenchCommand: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.runCommand(request)),
      onWorkbenchRunCommandOutput: (listener) =>
        window.velarosWorkbenchFs.onRunCommandOutput(listener),
      startWorkbenchTerminalSession: async (request) =>
        toHostResult(await window.velarosWorkbenchTerminal.startSession(request)),
      writeWorkbenchTerminalInput: async (request) =>
        toHostResult(await window.velarosWorkbenchTerminal.writeInput(request)),
      stopWorkbenchTerminalSession: async (request) =>
        toHostResult(await window.velarosWorkbenchTerminal.stopSession(request)),
      reportWorkbenchAgentWorkspaceSignals: () => notConnected(),
      getWorkbenchInlineCompletion: () => notConnected(),
      onWorkbenchTerminalOutput: (listener) =>
        window.velarosWorkbenchTerminal.onOutput(listener),
      onWorkbenchProjectAiIndexStatusChanged: () => noopUnsubscribe,
      onWorkbenchEditorCommand: () => noopUnsubscribe,
      acknowledgeWorkbenchEditorCommand: () => notConnected(),
      listWorkbenchLanguageGrammars: async () =>
        toHostResult(await window.velarosWorkbenchLanguage.listGrammars()),
      installWorkbenchLanguageGrammar: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.installGrammar(request)),
      onWorkbenchLanguageGrammarsChanged: (listener) =>
        window.velarosWorkbenchLanguage.onGrammarsChanged(listener),
    },
    sessions: {
      listFlaggedTasksByRoot: () => notConnected(),
      getFlaggedTaskDetail: () => notConnected(),
      acceptFlaggedTasks: () => notConnected(),
      dismissFlaggedTask: () => notConnected(),
      onFlaggedTaskChanged: () => noopUnsubscribe,
      loadOlderMessages: () => notConnected(),
      onHookSendTask: () => noopUnsubscribe,
      readLocalAttachmentFile: () => notConnected(),
      writeLocalAttachmentFile: () => notConnected(),
    },
    settings: {
      listProviderModels: () => notConnected(),
    },
    workspace: {
      openPath: () => notConnected(),
      getFileChangePreview: () => notConnected(),
      rollbackFileChange: () => notConnected(),
      restoreFileChange: () => notConnected(),
      pickDirectory: () => notConnected(),
      addWorkspaceRoot: () => notConnected(),
      setActiveWorkspaceRoot: () => notConnected(),
      getWorkspaceGitSummary: async (workspaceRoot) =>
        toHostResult(await window.velarosWorkbenchGit.getSummary({ workspaceRoot })),
      getWorkspaceGitLineStats: async (workspaceRoot) =>
        toHostResult(await window.velarosWorkbenchGit.getLineStats({ workspaceRoot })),
      getWorkspaceGitDiff: async (workspaceRoot, options) =>
        toHostResult(
          await window.velarosWorkbenchGit.getDiff({ workspaceRoot, ...options })
        ),
      getWorkspaceGitFileAtCommit: async (workspaceRoot, options) =>
        toHostResult(
          await window.velarosWorkbenchGit.getFileAtCommit({ workspaceRoot, ...options })
        ),
      getWorkspaceGitLog: async (workspaceRoot, options) =>
        toHostResult(
          await window.velarosWorkbenchGit.getLog({ workspaceRoot, ...options })
        ),
      generateWorkspaceGitCommitMessage: async (workspaceRoot, locale, paths) =>
        toHostResult(
          await window.velarosWorkbenchGit.generateCommitMessage({
            workspaceRoot,
            locale,
            paths,
          })
        ),
      commitWorkspaceGitChanges: async (workspaceRoot, locale, message, paths) =>
        toHostResult(
          await window.velarosWorkbenchGit.commit({
            workspaceRoot,
            locale,
            message,
            paths,
          })
        ),
      performWorkspaceGitFileAction: async (workspaceRoot, path, action) =>
        toHostResult(
          await window.velarosWorkbenchGit.performFileAction({
            workspaceRoot,
            path,
            action,
          })
        ),
      initializeWorkspaceGitRepository: async (workspaceRoot) =>
        toHostResult(await window.velarosWorkbenchGit.initialize({ workspaceRoot })),
      switchWorkspaceGitBranch: async (workspaceRoot, branch, locale, options) =>
        toHostResult(
          await window.velarosWorkbenchGit.switchBranch({
            workspaceRoot,
            branch,
            locale,
            ...options,
          })
        ),
      createWorkspaceGitBranch: async (workspaceRoot, branch) =>
        toHostResult(
          await window.velarosWorkbenchGit.createBranch({ workspaceRoot, branch })
        ),
      performWorkspaceGitAction: async (workspaceRoot, action, options) =>
        toHostResult(
          await window.velarosWorkbenchGit.performRemoteAction({
            workspaceRoot,
            action,
            ...options,
          })
        ),
    },
  },
  shell: {
    openChatWindow: (): Promise<void> => Promise.resolve(),
    openSettingsWindow: (): Promise<void> => Promise.resolve(),
  },
}

/** 独立 Workbench 应用入口在渲染前调用，安装占位宿主适配器。 */
export function installStandaloneWorkbenchHost(): void {
  installWorkbenchHost(standaloneWorkbenchHost)
}

export { standaloneWorkbenchHost }
