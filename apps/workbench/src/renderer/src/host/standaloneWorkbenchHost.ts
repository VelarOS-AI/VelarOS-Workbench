import { AppError, Result } from '@velaros-ai/core'
import type { Result as ResultType } from '@velaros-ai/core/result'
import type {
  SystemOverview,
  WorkbenchIndexProjectRequest,
  WorkbenchIndexProjectResult,
  WorkbenchProjectAiIndexStatus,
  WorkbenchProjectAiRuleFile,
  WorkbenchProjectAiRuleSource,
  WorkbenchProjectAiRulesResult,
} from '@velaros-ai/workbench/contracts'
import { installWorkbenchHost, type WorkbenchHost } from '@velaros-ai/workbench/host'

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
 * 可选能力也必须返回稳定结果：没有 CodeGraph/补全建议时返回空结果；会话附件走受项目根
 * 约束的文件 IPC；项目选择和系统打开走 ProjectHub main 端口。
 */
function invalidSession<T>(): ResultType<T> {
  return Result.fail(new AppError(
    'VALIDATION',
    'The Workbench session is not linked to an active project root.'
  ))
}

/** main 侧错误信封 → 产品端口 Result：跨进程边界的一次性升格点（保留 AppError 语义码）。 */
function toHostResult<T>(envelope: WorkbenchFsCallResult<T>): ResultType<T> {
  return envelope.ok
    ? Result.ok(envelope.value)
    : Result.fail(new AppError(envelope.code ?? 'UNKNOWN', envelope.message))
}

function noopUnsubscribe(): void {}

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

const aiIndexStatusByRoot = new Map<string, WorkbenchProjectAiIndexStatus>()

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
    'ws_list_files',
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
    'ws_read',
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

function createAiIndexStatus(
  projectRoot: string,
  projectIndex: WorkbenchIndexProjectResult,
  startedAt: number
): WorkbenchProjectAiIndexStatus {
  const packageFile = projectIndex.files.find((file) => file.path === 'package.json')
  let packageName: string | null = null
  try {
    const parsed = packageFile ? JSON.parse(packageFile.content) as { name?: unknown } : null
    packageName = typeof parsed?.name === 'string' ? parsed.name : null
  } catch {
    packageName = null
  }
  const languages = [...new Set(projectIndex.files.map((file) =>
    file.path.split('.').at(-1)?.toLowerCase() ?? '').filter(Boolean))]
  const status: WorkbenchProjectAiIndexStatus = {
    projectRoot,
    projectId: stableRootId(projectRoot),
    projectName: projectRoot.split(/[\\/]/).at(-1) ?? projectRoot,
    status: 'ready',
    phase: 'ready',
    memoryId: null,
    indexedAt: Date.now(),
    startedAt,
    updatedAt: Date.now(),
    scannedFiles: projectIndex.scannedFiles,
    indexedFiles: projectIndex.files.length,
    skippedFiles: projectIndex.skippedFiles,
    error: null,
    packageName,
    packageManager: inferPackageManager(projectIndex),
    keyFileCount: projectIndex.files.filter((file) =>
      /(^|\/)(package\.json|README|AGENTS\.md|tsconfig\.json)/i.test(file.path)).length,
    likelyCommandCount: 0,
    sourceRootCount: new Set(projectIndex.files.map((file) => file.path.split('/')[0])).size,
    languages,
    codeIndex: {
      providerId: '@velaros-ai/workspace',
      providerLabel: 'VelarOS Workspace',
      version: '1.2.2',
      initialized: false,
      indexing: false,
      watching: false,
      fileCount: projectIndex.files.length,
      nodeCount: 0,
      edgeCount: 0,
      frameworks: [],
      backend: 'workspace',
      journalMode: null,
      pendingFileCount: 0,
      lastError: null,
      skipped: true,
    },
  }
  aiIndexStatusByRoot.set(projectRoot, status)
  return status
}

function isWorkspaceFileEntry(value: unknown): value is WorkspaceFileEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.path === 'string'
    && (record.type === 'file' || record.type === 'directory')
  )
}

function stableRootId(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `workspace-${Math.abs(hash).toString(36)}`
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

function inferPackageManager(projectIndex: WorkbenchIndexProjectResult): string | null {
  if (projectIndex.files.some((file) => file.path === 'bun.lock')) return 'bun'
  if (projectIndex.files.some((file) => file.path === 'pnpm-lock.yaml')) return 'pnpm'
  if (projectIndex.files.some((file) => file.path === 'yarn.lock')) return 'yarn'
  if (projectIndex.files.some((file) => file.path === 'package-lock.json')) return 'npm'
  return null
}

function ruleSource(path: string): WorkbenchProjectAiRuleSource {
  if (path.includes('CLAUDE')) return 'claude'
  if (path.includes('.cursor')) return 'cursor'
  if (path.includes('copilot')) return 'copilot'
  return 'codex'
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

function splitWorkspaceDiff(diff: string): { beforeContent: string; afterContent: string } {
  const before: string[] = []
  const after: string[] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue
    if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith('+')) after.push(line.slice(1))
    else if (line.startsWith(' ')) {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
  }
  return { beforeContent: before.join('\n'), afterContent: after.join('\n') }
}

async function readProjectAiRules(
  projectRoot: string
): Promise<ResultType<WorkbenchProjectAiRulesResult>> {
  const listed = await invokeWorkspace<unknown[]>(projectRoot, 'ws_list_files', {
    path: '.',
    recursive: true,
    maxDepth: 4,
    maxFiles: 500,
    include: [
      'AGENTS.md',
      '**/AGENTS.md',
      'CLAUDE.md',
      '.cursorrules',
      '.cursor/rules/**',
      '.github/copilot-instructions.md',
    ],
  })
  if (!listed.ok) return listed as ResultType<WorkbenchProjectAiRulesResult>
  const paths = listed.data.filter(isWorkspaceFileEntry)
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path)
  if (paths.length === 0) return Result.ok({
    projectRoot,
    files: [],
    totalChars: 0,
    truncatedFiles: 0,
    omittedFiles: 0,
  })
  const read = await invokeWorkspace<WorkspaceReadManyResult>(
    projectRoot,
    'ws_read',
    { path: paths, maxChars: 64_000 }
  )
  if (!read.ok) return read as ResultType<WorkbenchProjectAiRulesResult>
  const files: WorkbenchProjectAiRuleFile[] = read.data.files.map((file) => {
    const source = ruleSource(file.snapshot.path)
    return {
      source,
      sourceLabel: source,
      relativePath: file.snapshot.path,
      content: file.content ?? '',
      truncated: file.truncated ?? false,
    }
  })
  return Result.ok({
    projectRoot,
    files,
    totalChars: files.reduce((total, file) => total + file.content.length, 0),
    truncatedFiles: files.filter((file) => file.truncated).length,
    omittedFiles: paths.length - files.length,
  })
}

const standaloneWorkbenchHost: WorkbenchHost = {
  kernel: {
    project: {
      listWorkbenchDirectory: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.listDirectory(request)),
      readWorkbenchFile: async (request) =>
        toHostResult(await window.velarosWorkbenchFs.readFile(request)),
      indexWorkbenchProject: indexProjectWithWorkspace,
      startWorkbenchProjectAiIndex: async (request) => {
        const startedAt = Date.now()
        const projectIndex = await indexProjectWithWorkspace(request)
        if (!projectIndex.ok) return projectIndex
        return Result.ok({
          projectIndex: projectIndex.data,
          status: createAiIndexStatus(
            request.projectRoot,
            projectIndex.data,
            startedAt
          ),
          scheduled: false,
        })
      },
      getWorkbenchProjectAiIndexStatus: (request) => {
        const status = aiIndexStatusByRoot.get(request.projectRoot)
        return Promise.resolve(Result.ok(status ?? {
          projectRoot: request.projectRoot,
          projectId: stableRootId(request.projectRoot),
          projectName: request.projectRoot.split(/[\\/]/).at(-1) ?? request.projectRoot,
          status: 'not-indexed',
          phase: 'not-indexed',
          memoryId: null,
          indexedAt: null,
          startedAt: null,
          updatedAt: null,
          scannedFiles: 0,
          indexedFiles: 0,
          skippedFiles: 0,
          error: null,
          packageName: null,
          packageManager: null,
          keyFileCount: 0,
          likelyCommandCount: 0,
          sourceRootCount: 0,
          languages: [],
        }))
      },
      getWorkbenchProjectAiRules: (request) =>
        readProjectAiRules(request.projectRoot),
      getWorkbenchCodeGraph: (request) => Promise.resolve(Result.ok({
        projectRoot: request.projectRoot,
        mode: request.mode,
        nodes: [],
        edges: [],
        truncated: false,
      })),
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
      reportWorkbenchAgentWorkspaceSignals: () => Promise.resolve(Result.ok(undefined)),
      getWorkbenchInlineCompletion: () => Promise.resolve(Result.ok({ completion: '' })),
      onWorkbenchTerminalOutput: (listener) =>
        window.velarosWorkbenchTerminal.onOutput(listener),
      onWorkbenchProjectAiIndexStatusChanged: () => noopUnsubscribe,
      onWorkbenchEditorCommand: () => noopUnsubscribe,
      acknowledgeWorkbenchEditorCommand: () => Promise.resolve(Result.ok(undefined)),
      listWorkbenchLanguageGrammars: async () =>
        toHostResult(await window.velarosWorkbenchLanguage.listGrammars()),
      installWorkbenchLanguageGrammar: async (request) =>
        toHostResult(await window.velarosWorkbenchLanguage.installGrammar(request)),
      onWorkbenchLanguageGrammarsChanged: (listener) =>
        window.velarosWorkbenchLanguage.onGrammarsChanged(listener),
    },
    sessions: {
      loadOlderMessages: (request) => Promise.resolve(Result.ok({
        messages: [],
        loadedFromIndex: Math.max(0, request.beforeIndex),
        hasMore: false,
      })),
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
      getFileChangePreview: async (sessionId, changeId, path) => {
        const projectRoot = projectRootFromSessionId(sessionId)
        if (!projectRoot) return invalidSession()
        const diff = await invokeWorkspace<{
          diff: string
          changedFiles: string[]
        }>(projectRoot, 'ws_diff', { transactionId: changeId })
        if (!diff.ok) return diff
        const contents = splitWorkspaceDiff(diff.data.diff)
        return Result.ok({
          changeId,
          rootPath: projectRoot,
          path: path ?? diff.data.changedFiles[0] ?? '',
          created: contents.beforeContent.length === 0,
          rolledBack: false,
          revertAvailable: true,
          ...contents,
        })
      },
      rollbackFileChange: async (sessionId, changeId, path) => {
        const projectRoot = projectRootFromSessionId(sessionId)
        if (!projectRoot) return invalidSession()
        const rollback = await invokeWorkspace<{
          changedFiles: string[]
        }>(projectRoot, 'ws_rollback', { transactionId: changeId })
        if (!rollback.ok) return rollback
        return Result.ok({
          changeId,
          path: path ?? rollback.data.changedFiles[0] ?? '',
          rolledBack: true,
          alreadyRolledBack: false,
        })
      },
      restoreFileChange: () => Promise.resolve(Result.fail(new AppError(
        'UNKNOWN',
        'The published Workspace capability does not expose transaction restore.'
      ))),
      pickDirectory: async () => {
        const picked = await window.velarosWorkbenchProjectHub.pickNewProjectLocation()
        return Result.ok(picked.ok ? picked.path : null)
      },
      addWorkspaceRoot: async (_sessionId, path) => {
        const opened = await window.velarosWorkbenchProjectHub.openProjectPath(path)
        if (!opened.ok) return Result.fail(new AppError('VALIDATION', `Cannot open project root: ${path}`))
        return Result.ok(createSystemOverview(opened.project.path))
      },
      setActiveWorkspaceRoot: async (_sessionId, path) => {
        const opened = await window.velarosWorkbenchProjectHub.openProjectPath(path)
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

/** 独立 Workbench 应用入口在渲染前调用，安装语义宿主适配器。 */
export function installStandaloneWorkbenchHost(): void {
  installWorkbenchHost(standaloneWorkbenchHost)
}

export { standaloneWorkbenchHost }
