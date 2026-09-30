import { installWorkbenchHost, type WorkbenchHost } from '@renderer/host'
import { WorkbenchRuntime } from '@renderer/runtime'
import { getStandaloneWorkbenchModelConfig } from '@renderer/runtime/standaloneWorkbenchModelConfig'

import { AppError, Result } from '@velaros-ai/core'
import type { Result as ResultType } from '@velaros-ai/core/result'

import type {
  SystemOverview,
  WorkbenchIndexProjectRequest,
  WorkbenchIndexProjectResult,
  WorkbenchProjectAiRulesResult,
} from '@shared/contracts'

import type { WorkbenchFsCallResult } from '../../../shared/workbenchFs'
import type {
  WorkbenchWorkspaceInvokeResult,
  WorkbenchWorkspaceOperation,
} from '../../../shared/workbenchWorkspace'

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
 * 可选能力也必须返回稳定结果：没有补全建议时返回空结果；会话附件走受项目根
 * 约束的文件 IPC；项目选择和系统打开走 ProjectHub main 端口。
 */

/** main 侧错误信封 → 产品端口 Result：跨进程边界的一次性升格点（保留 AppError 语义码）。 */
function toHostResult<T>(envelope: WorkbenchFsCallResult<T>): ResultType<T> {
  return envelope.ok
    ? Result.ok(envelope.value)
    : Result.fail(new AppError(envelope.code ?? 'UNKNOWN', envelope.message))
}

function invalidSession<T>(): ResultType<T> {
  return Result.fail(new AppError(
    'VALIDATION',
    'The Workbench session is not linked to an active project root.'
  ))
}

interface WorkspaceFileEntry {
  path: string
  type: 'file' | 'directory'
}

interface WorkspaceReadManyResult {
  files: Array<{
    snapshot: {
      path: string
      size: number
      mtimeMs: number
    }
    content?: string
    totalLines?: number
    truncated?: boolean
  }>
}

async function invokeWorkspace<T>(
  projectRoot: string,
  operation: WorkbenchWorkspaceOperation,
  input: unknown
): Promise<ResultType<T>> {
  const result = await window.velarosWorkbenchWorkspace.invoke({
    projectRoot,
    operation,
    input,
  })
  return toWorkspaceHostResult<T>(result)
}

function toWorkspaceHostResult<T>(
  envelope: WorkbenchWorkspaceInvokeResult
): ResultType<T> {
  return envelope.ok
    ? Result.ok(envelope.output as T)
    : Result.fail(new AppError('UNKNOWN', envelope.error.message))
}

async function indexProjectWithWorkspace(
  request: WorkbenchIndexProjectRequest
): Promise<ResultType<WorkbenchIndexProjectResult>> {
  const listed = await invokeWorkspace<unknown[]>(
    request.projectRoot,
    'project:list',
    {
      path: request.path ?? '.',
      recursive: true,
      maxDepth: request.maxDepth ?? 4,
      maxFiles: request.maxFiles ?? 120,
    }
  )
  if (!listed.ok) return listed as ResultType<WorkbenchIndexProjectResult>

  const paths = listed.data
    .filter(isWorkspaceFileEntry)
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path)
  if (paths.length === 0) return Result.ok({
    projectRoot: request.projectRoot,
    path: request.path ?? '.',
    files: [],
    scannedFiles: 0,
    skippedFiles: 0,
    truncated: false,
  })

  const read = await invokeWorkspace<WorkspaceReadManyResult>(
    request.projectRoot,
    'project:read',
    {
      path: paths,
      maxChars: request.maxCharsPerFile ?? 24_000,
      maxBytes: request.maxFileBytes ?? 160_000,
    }
  )
  if (!read.ok) return read as ResultType<WorkbenchIndexProjectResult>

  const files = read.data.files
    .filter((file) => typeof file.content === 'string')
    .map((file) => ({
      path: file.snapshot.path,
      content: file.content ?? '',
      size: file.snapshot.size,
      modifiedAt: file.snapshot.mtimeMs,
      totalLines: file.totalLines ?? file.content?.split('\n').length ?? 0,
      truncated: file.truncated ?? false,
    }))
  return Result.ok({
    projectRoot: request.projectRoot,
    path: request.path ?? '.',
    files,
    scannedFiles: paths.length,
    skippedFiles: paths.length - files.length,
    truncated: paths.length >= (request.maxFiles ?? 120),
  })
}

function isWorkspaceFileEntry(value: unknown): value is WorkspaceFileEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.path === 'string'
    && (record.type === 'file' || record.type === 'directory')
  )
}

function createSystemOverview(activeWorkspaceRoot: string): SystemOverview {
  return {
    providers: [{
      id: 'workbench-project-hub',
      label: 'Workbench Project Hub',
      description: 'Standalone Workbench project root provider.',
      capabilities: ['workspace-roots', 'open-path'],
    }],
    workspaceRoots: [{
      path: activeWorkspaceRoot,
      active: true,
      exists: true,
      removable: false,
      source: 'project',
    }],
    activeWorkspaceRoot,
    browserSiteContext: null,
  }
}

function projectRootFromSessionId(sessionId: string): string | null {
  const prefix = 'workbench-chat:'
  if (!sessionId.startsWith(prefix)) return null
  try {
    const root = decodeURIComponent(sessionId.slice(prefix.length)).trim()
    return root || null
  } catch {
    return null
  }
}

const standaloneWorkbenchHost: WorkbenchHost = {
  kernel: {
    project: {
      listWorkbenchDirectory: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.listDirectory(request)),
      readWorkbenchFile: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.readFile(request)),
      readWorkbenchImageFile: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.readImageFile(request)),
      findExistingWorkbenchFiles: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.findExistingFiles(request)),
      indexWorkbenchProject: indexProjectWithWorkspace,
      // 设置页「AI 规则」列的就是每轮交给 Agent 的那一份（主进程按同一套约定去找）。
      getWorkbenchProjectAiRules: (request) =>
        invokeWorkspace<WorkbenchProjectAiRulesResult>(request.projectRoot, 'project:rules', {}),
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
      copyWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.copyEntry(request)),
      inspectWorkbenchDeleteEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.inspectDeleteEntry(request)),
      deleteWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.deleteEntry(request)),
      restoreDeletedWorkbenchEntry: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.restoreDeletedEntry(request)),
      restoreMissingWorkbenchFile: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.restoreMissingFile(request)),
      searchWorkbenchEntries: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.searchEntries(request)),
      searchWorkbenchContent: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.searchContent(request)),
      cancelWorkbenchContentSearch: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.cancelSearchContent(request)),
      onWorkbenchContentSearchProgress: (listener) =>
        window.velarosWorkbenchFs.onSearchContentProgress(listener),
      listWorkbenchProjectFiles: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.listProjectFiles(request)),
      getWorkbenchLanguageServiceDefinition: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getDefinition(request)),
      getWorkbenchLanguageServiceCompletions: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getCompletions(request)),
      resolveWorkbenchLanguageServiceCompletion: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.resolveCompletion(request)),
      getWorkbenchLanguageServiceDiagnostics: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getDiagnostics(request)),
      getWorkbenchLanguageServiceProjectDiagnostics: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getProjectDiagnostics(request)),
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
      getWorkbenchLanguageServiceSemanticTokens: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getSemanticTokens(request)),
      getWorkbenchLanguageServiceCodeActions: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.getCodeActions(request)),
      requestWorkbenchLanguageServiceExtension: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.requestExtension(request)),
      runWorkbenchCommand: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.runCommand(request)),
      onWorkbenchRunCommandOutput: (listener) =>
        window.velarosWorkbenchFs.onRunCommandOutput(listener),
      startWorkbenchTerminalSession: async (request) =>
        toHostResult(await window.velarosWorkbenchTerminal.startSession(request)),
      writeWorkbenchTerminalInput: async (request) =>
        toHostResult(await window.velarosWorkbenchTerminal.writeInput(request)),
      resizeWorkbenchTerminalSession: async (request) =>
        toHostResult(await window.velarosWorkbenchTerminal.resizeSession(request)),
      stopWorkbenchTerminalSession: async (request) =>
        toHostResult(await window.velarosWorkbenchTerminal.stopSession(request)),
      getWorkbenchInlineCompletion: async (request) => {
        const modelConfig = getStandaloneWorkbenchModelConfig()
        return toHostResult(await window.velarosWorkbenchLanguage.getInlineCompletion({
          ...request,
          modelSelection: {
            provider: modelConfig.provider,
            model: modelConfig.completionModel,
            apiKey: modelConfig.apiKey,
            baseURL: modelConfig.baseURL,
          },
        }))
      },
      onWorkbenchTerminalOutput: (listener) =>
        window.velarosWorkbenchTerminal.onOutput(listener),
      acknowledgeWorkbenchTerminalOutput: (request) =>
        window.velarosWorkbenchTerminal.acknowledgeOutput(request),
    },
    sessions: {
      readLocalAttachmentFile: async (request) => {
        const projectRoot = projectRootFromSessionId(request.sessionId)
        if (!projectRoot) return invalidSession()
        const result = toHostResult(await window.velarosWorkbenchFs.readFile({
          projectRoot,
          path: request.path,
        }))
        if (!result.ok) return result
        return Result.ok({
          path: result.data.path,
          name: request.name ?? result.data.path.split(/[\\/]/).at(-1) ?? result.data.path,
          mediaType: request.mediaType ?? 'text/plain',
          size: result.data.size,
          lastModified: result.data.modifiedAt,
          data: new TextEncoder().encode(result.data.content),
        })
      },
      writeLocalAttachmentFile: async (request) => {
        const projectRoot = projectRootFromSessionId(request.sessionId)
        if (!projectRoot) return invalidSession()
        const result = toHostResult(await window.velarosWorkbenchFs.saveFile({
          projectRoot,
          path: request.path,
          content: request.content,
          expectedModifiedAt: request.expectedLastModified,
          expectedSize: request.expectedSize,
        }))
        if (!result.ok) return result
        return Result.ok({
          path: result.data.path,
          size: result.data.size,
          lastModified: result.data.modifiedAt,
        })
      },
    },
    settings: {
      listProviderModels: (request) => Promise.resolve(Result.ok({
        provider: request.provider,
        source: 'preset',
        models: request.defaultModel
          ? [{ id: request.defaultModel, label: request.defaultModel }]
          : [],
        fetchedAt: Date.now(),
      })),
    },
    workspace: {
      openPath: async (_sessionId, path, options) => {
        const opened = await window.velarosWorkbenchProjectHub.openSystemPath(path)
        return Result.ok({
          path,
          opened: opened.opened,
          editor: options?.editor,
          application: opened.error,
        })
      },
      pickDirectory: async () => {
        const picked = await window.velarosWorkbenchProjectHub.pickNewProjectLocation()
        return Result.ok(picked.ok ? picked.path : null)
      },
      addWorkspaceRoot: async (_sessionId, path) => {
        const opened = await window.velarosWorkbenchProjectHub.validateProjectPath(path)
        if (!opened.ok) return Result.fail(new AppError('VALIDATION', `Cannot open project root: ${path}`))
        return Result.ok(createSystemOverview(opened.project.path))
      },
      setActiveWorkspaceRoot: async (_sessionId, path) => {
        const opened = await window.velarosWorkbenchProjectHub.validateProjectPath(path)
        if (!opened.ok) return Result.fail(new AppError('VALIDATION', `Cannot activate project root: ${path}`))
        return Result.ok(createSystemOverview(opened.project.path))
      },
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
      getWorkspaceGitBlame: async (workspaceRoot, options) =>
        toHostResult(await window.velarosWorkbenchGit.getBlame({ ...options, workspaceRoot })),
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
      commitWorkspaceGitStagedChanges: async (workspaceRoot, locale, message) =>
        toHostResult(
          await window.velarosWorkbenchGit.commit({
            workspaceRoot,
            locale,
            message,
            staged: true,
          })
        ),
      performWorkspaceGitFileAction: async (workspaceRoot, paths, action) =>
        toHostResult(
          await window.velarosWorkbenchGit.performFileAction({
            workspaceRoot,
            paths,
            action,
          })
        ),
      performWorkspaceGitHunkAction: async (workspaceRoot, options) =>
        toHostResult(
          await window.velarosWorkbenchGit.performHunkAction({ workspaceRoot, ...options })
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

/** 独立 Workbench 应用入口在渲染前调用，安装语义宿主适配器。 */
export function installStandaloneWorkbenchHost(): WorkbenchRuntime {
  installWorkbenchHost(standaloneWorkbenchHost)
  return new WorkbenchRuntime({
    host: standaloneWorkbenchHost,
  })
}

export { standaloneWorkbenchHost }
