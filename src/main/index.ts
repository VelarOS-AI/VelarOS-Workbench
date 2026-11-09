import { statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { app, BrowserWindow, session, shell, webContents } from 'electron'

import { createElectronBrowserRuntime } from '@velaros-ai/capabilities/browser/electron'
import { Log } from '@velaros-ai/velaros/core'
import { createShellEnvironment } from '@velaros-ai/velaros/execution/local'
import { createModelRuntimeComposition } from '@velaros-ai/velaros/model'

import productionAppIconPath from '../../resources/icons/icon.png?asset'
import developmentAppIconPath from '../../resources/icons/icon-dev.png?asset'
import {
  normalizeWorkbenchBrowserPageUrl,
  WorkbenchBrowserPartition,
} from '../shared/workbenchBrowser'

import { registerWorkbenchAccountIpc } from './account/WorkbenchAccountIpc'
import { WorkbenchAccountService } from './account/WorkbenchAccountService'
import { WorkbenchSharedAccountStore } from './account/WorkbenchSharedAccountStore'
import { WorkbenchProductAnalyticsReporter } from './analytics/WorkbenchProductAnalyticsReporter'
import { installWorkbenchProductAnalyticsRuntime } from './analytics/WorkbenchProductAnalyticsRuntime'
import { WorkbenchBrowserBackgroundPages } from './browser/WorkbenchBrowserBackgroundPages'
import { registerWorkbenchBrowserIpc } from './browser/WorkbenchBrowserIpc'
import {
  installWorkbenchBrowserDefaultPermissionPolicy,
  registerWorkbenchBrowserRuntimePermissionHandler,
} from './browser/WorkbenchBrowserPermissionPolicy'
import { WorkbenchBrowserService } from './browser/WorkbenchBrowserService'
import { WorkbenchBrowserWebviewGate } from './browser/WorkbenchBrowserWebviewGate'
import { registerWorkbenchAgentProcessesIpc } from './conversation/WorkbenchAgentProcessesIpc'
import { createWorkbenchConversationConfiguration } from './conversation/WorkbenchConversationConfiguration'
import { createWorkbenchConversationDispatcher } from './conversation/WorkbenchConversationDispatcher'
import { registerWorkbenchConversationIpc } from './conversation/WorkbenchConversationIpc'
import { createWorkbenchConversationRuntime } from './conversation/WorkbenchConversationRuntime'
import { registerWorkbenchMemoryIpc } from './conversation/WorkbenchMemoryIpc'
import { WorkbenchMemoryService } from './conversation/WorkbenchMemoryService'
import { resolveWorkbenchNodeExecutable } from './conversation/WorkbenchNodeRuntime'
import { registerWorkbenchSessionPeersIpc } from './conversation/WorkbenchSessionPeersIpc'
import { WorkbenchShellHostRegistry } from './conversation/WorkbenchShellHostRegistry'
import { loadWorkbenchShellTerminal } from './conversation/WorkbenchShellTerminal'
import { WorkbenchWebSearchPages } from './conversation/WorkbenchWebSearchPages'
import { ClaudeCodeEngine } from './engines/ClaudeCodeEngine'
import { CodexEngine } from './engines/CodexEngine'
import { WorkbenchEngineConversationRuntime } from './engines/WorkbenchEngineConversationRuntime'
import { WorkbenchEngineSessionStore } from './engines/WorkbenchEngineSessionStore'
import { setWorkbenchSystemLanguageSource } from './i18n/workbenchMainLocale'
import { registerWorkbenchModelIpc } from './model/WorkbenchModelIpc'
import type { WorkbenchProjectHub } from './projects/ProjectHub'
import { registerProjectHubIpc } from './projects/ProjectHubIpc'
import { installProjectHubMenu } from './projects/ProjectHubMenu'
import { WorkbenchAgentConsoleWindows } from './projects/WorkbenchAgentConsoleWindows'
import { installWorkbenchEditorZoom } from './projects/WorkbenchEditorZoom'
import {
  installWorkbenchExternalNavigation,
  isWorkbenchAgentConsoleRequest,
} from './projects/WorkbenchExternalNavigation'
import { WorkbenchProjectRegistry } from './projects/WorkbenchProjectRegistry'
import { prepareWorkbenchWebviewAttachment } from './projects/WorkbenchWebviewSecurity'
import { WorkbenchWindowCloseGuard } from './projects/WorkbenchWindowCloseGuard'
import { registerWorkbenchWindowCloseIpc } from './projects/WorkbenchWindowCloseIpc'
import { WorkbenchWindowManager } from './projects/WorkbenchWindowManager'
import { installWorkbenchWindowState } from './projects/WorkbenchWindowState'
import { registerWorkbenchWindowStateIpc } from './projects/WorkbenchWindowStateIpc'
import { installWorkbenchUpdateRuntime } from './updates/WorkbenchUpdateRuntime'
import { registerWorkbenchDebugIpc } from './workspace/debug/WorkbenchDebugIpc'
import { registerWorkbenchGitIpc } from './workspace/git/WorkbenchGitIpc'
import { WorkbenchInlineCompletionGenerator } from './workspace/language/WorkbenchInlineCompletion'
import { registerWorkbenchLanguageServiceIpc } from './workspace/language/WorkbenchLanguageServiceIpc'
import {
  languageSyncOnAgentEdits,
  withLanguageSyncOnUserWrites,
} from './workspace/language/WorkbenchLanguageWriteSync'
import { registerWorkbenchTerminalIpc } from './workspace/terminal/WorkbenchTerminalIpc'
import { registerWorkbenchWatchIpc } from './workspace/watch/WorkbenchWatchIpc'
import { registerWorkbenchFsIpc } from './workspace/WorkbenchFsIpc'
import { registerWorkbenchWorkspaceIpc } from './workspace/WorkbenchWorkspaceIpc'
import {
  resolveVelarOSOfficialWebsiteMarket,
  resolveVelarOSOfficialWebsiteOrigin,
  resolveVelarOSOfficialWebsiteUrl,
} from './VelarOSOfficialWebsite'
import { createDefaultWorkbenchMainCapabilityProviders } from './WorkbenchMainCapabilityProviders'

/**
 * 独立 VelarOS Workbench 应用的主进程。
 *
 * 负责多窗口生命周期 + 项目枢纽（一个项目一个窗口、起手页三主动作、最近项目持久化、
 * Finder / 第二实例目录投递、窗口标题与菜单跟随焦点项目状态）。
 * IDE 本地能力由应用私有 IPC 语义端口承载；主聊天接 VelarOS Platform 的会话运行时（与 Desktop 同一套：
 * 模型写脚本、隔离子进程执行、项目与命令能力由 Platform 模块提供），不反向依赖 Desktop。
 *
 * 数据根对齐 Desktop 惯例（prod=userData，dev=cwd/.velaros/data 隔离目录），但完全独立于 Desktop 的
 * chat 存储：应用名固定 `VelarOS Workbench`，prod userData 因此拥有自己的平台目录。
 */
const WorkbenchProductName = 'VelarOS Workbench'
const WorkbenchWindowWidth = 1280
const WorkbenchWindowHeight = 800
const PlatformNames: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}
/** 给模型看的操作系统：产品名、系统版本与架构，例如 macOS 26.3.1 (arm64)；进程内不变，启动时算一次。 */
const WorkbenchHostEnvironment = Object.freeze({
  os: `${PlatformNames[process.platform] ?? process.platform} ${process.getSystemVersion()} (${process.arch})`,
})

function isWorkbenchDevelopmentRuntime(): boolean {
  return process.env['NODE_ENV'] === 'development' || !app.isPackaged
}

const WorkbenchIsDevelopmentRuntime = isWorkbenchDevelopmentRuntime()
const WorkbenchApplicationName = WorkbenchIsDevelopmentRuntime
  ? `${WorkbenchProductName} Dev`
  : WorkbenchProductName
const WorkbenchApplicationIconPath = WorkbenchIsDevelopmentRuntime
  ? developmentAppIconPath
  : productionAppIconPath

interface WorkbenchInstanceLaunchData {
  productName: string
  executablePath: string
  version: string
  externalPaths: string[]
}

app.setName(WorkbenchApplicationName)
if (WorkbenchIsDevelopmentRuntime) {
  app.setPath('userData', join(process.cwd(), '.velaros', 'data', 'workbench-app'))
}

let windowManager: Nullable<WorkbenchWindowManager> = null
// 有未保存编辑器改动的窗口，关窗与退出前先交给 renderer 存或问；答应了才继续退出。
const windowCloseGuard = new WorkbenchWindowCloseGuard(() => app.quit())
const agentConsoleWindows = new WorkbenchAgentConsoleWindows()
let productAnalytics: WorkbenchProductAnalyticsReporter | undefined
let workbenchBrowserWebviewGate: Nullable<WorkbenchBrowserWebviewGate> = null
const pendingExternalPaths = collectExternalPathArguments(process.argv)

app.on('open-file', (event, path) => {
  event.preventDefault()
  dispatchExternalPaths([path])
})

const instanceLaunchData: WorkbenchInstanceLaunchData = {
  productName: WorkbenchApplicationName,
  executablePath: process.execPath,
  version: app.getVersion(),
  externalPaths: pendingExternalPaths,
}
const hasSingleInstanceLock = app.requestSingleInstanceLock(instanceLaunchData)
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    if (relaunchFromRequestedWorkbenchPackage(additionalData)) return

    const paths = collectExternalPathArguments(argv, workingDirectory)
    if (paths.length > 0) {
      dispatchExternalPaths(paths)
      return
    }

    windowManager?.activateOrCreateWindow()
  })
}

function resolveWorkbenchDataRootDir(): string {
  return app.getPath('userData')
}

function getWorkbenchWindowTitle(projectName: Nullable<string>): string {
  return process.platform === 'win32'
    ? 'VelarOS WorkBench'
    : (projectName ?? WorkbenchApplicationName)
}

function createWorkbenchWindow(hub: WorkbenchProjectHub): BrowserWindow {
  const window = new BrowserWindow({
    width: WorkbenchWindowWidth,
    height: WorkbenchWindowHeight,
    minWidth: 900,
    minHeight: 600,
    icon: WorkbenchApplicationIconPath,
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#f7f7f7',
    title: getWorkbenchWindowTitle(hub.getState().currentProject?.name ?? null),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      sandbox: false,
      webviewTag: true,
      // electron-vite 对 type:module 应用输出 ESM preload（.mjs）。
      preload: join(__dirname, '../preload/index.mjs'),
    },
  })

  installWorkbenchExternalNavigation(
    (handler) => window.webContents.setWindowOpenHandler(handler),
    (url) => shell.openExternal(url),
    (url, error) => {
      Log.tag('WorkbenchExternalNavigation').warn('open_external_failed', { url, error })
    },
    {
      width: 720,
      height: 540,
      minWidth: 480,
      minHeight: 320,
      icon: WorkbenchApplicationIconPath,
      autoHideMenuBar: true,
      backgroundColor: '#f7f7f7',
    }
  )
  const consoleOwnerId = window.webContents.id
  window.webContents.on('did-create-window', (child, details) => {
    if (!isWorkbenchAgentConsoleRequest(details)) return
    agentConsoleWindows.register(consoleOwnerId, child)
    installWorkbenchExternalNavigation(
      (handler) => child.webContents.setWindowOpenHandler(handler),
      (url) => shell.openExternal(url)
    )
    child.webContents.on('will-navigate', (event) => event.preventDefault())
  })
  window.once('closed', () => agentConsoleWindows.releaseOwner(consoleOwnerId))
  window.webContents.on('render-process-gone', () =>
    agentConsoleWindows.releaseOwner(consoleOwnerId)
  )
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (
      !workbenchBrowserWebviewGate?.allowsAttachment() ||
      !prepareWorkbenchWebviewAttachment(webPreferences, params)
    )
      event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, guestContents) => {
    if (!workbenchBrowserWebviewGate?.track(guestContents)) return
    installWorkbenchExternalNavigation(
      (handler) => guestContents.setWindowOpenHandler(handler),
      (url) => shell.openExternal(url),
      (url, error) => {
        Log.tag('WorkbenchExternalNavigation').warn('open_guest_external_failed', { url, error })
      }
    )
    guestContents.on('will-navigate', (event, url) => {
      if (!normalizeWorkbenchBrowserPageUrl(url)) event.preventDefault()
    })
  })
  installWorkbenchEditorZoom(window)
  installWorkbenchWindowState(window)
  windowCloseGuard.install(window)

  // main 统一控制标题：Windows 固定产品名，其他平台跟随项目；禁止页面标题覆盖。
  window.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  const unsubscribeTitleSync = hub.onStateChanged((state) => {
    if (window.isDestroyed()) return

    window.setTitle(getWorkbenchWindowTitle(state.currentProject?.name ?? null))
  })
  window.on('closed', unsubscribeTitleSync)

  window.on('ready-to-show', () => {
    window.show()
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

if (hasSingleInstanceLock)
  void app.whenReady().then(async () => {
    if (WorkbenchIsDevelopmentRuntime) app.dock?.setIcon(WorkbenchApplicationIconPath)
    const dataRootDir = resolveWorkbenchDataRootDir()
    const disposeBrowserPermissionPolicy = installWorkbenchBrowserDefaultPermissionPolicy(
      session.fromPartition(WorkbenchBrowserPartition),
      { isInteractiveGuest: (guest) => workbenchBrowserWebviewGate?.ownsGuest(guest) === true }
    )
    const websiteMarket = resolveVelarOSOfficialWebsiteMarket({
      configuredMarket: process.env['VELAROS_MARKET'],
      locale: app.getLocale(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    const websiteOrigin = resolveVelarOSOfficialWebsiteOrigin(websiteMarket)
    productAnalytics = await WorkbenchProductAnalyticsReporter.create({
      dataRoot: dataRootDir,
      appVersion: app.getVersion(),
      isActive: () =>
        BrowserWindow.getAllWindows().some(
          (window) =>
            !window.isDestroyed() &&
            window.isVisible() &&
            !window.isMinimized() &&
            window.isFocused()
        ),
    }).catch(() => undefined)
    const disposeProductAnalyticsRuntime = installWorkbenchProductAnalyticsRuntime({
      dataRootDir,
      privacyDetailsUrl: resolveVelarOSOfficialWebsiteUrl(
        websiteMarket,
        '/privacy#product-improvement-data'
      ),
      reporter: productAnalytics,
    })
    const accountService = new WorkbenchAccountService(new WorkbenchSharedAccountStore(), (url) =>
      shell.openExternal(url)
    )
    const disposeAccountIpc = registerWorkbenchAccountIpc(accountService)
    // 界面里的调试浏览器（用户自己开的网页标签）：闸门只负责记下挂上来的页面，退出时一并关掉。
    workbenchBrowserWebviewGate = new WorkbenchBrowserWebviewGate()
    productAnalytics?.start()
    // 登录 shell 的环境全应用共用一份：Agent 的命令、外部引擎的命令行和 Git（连同提交钩子）都起在它里面。
    const shellEnvironment = createShellEnvironment()
    const providers = createDefaultWorkbenchMainCapabilityProviders(
      dataRootDir,
      { moveToTrash: (path) => shell.trashItem(path) },
      () => shellEnvironment.getEnvironment()
    )
    // 上次运行留下的删除撤销副本：撤销记录只在内存里，重启后已对不上；删掉的东西在系统废纸篓里。
    void providers.parts.files.purgePreviousDeleteUndoCopies()
    const modelComposition = createModelRuntimeComposition({
      environment: Object.freeze({ ...process.env }),
      providerCatalog: {
        attribution: {
          referer: websiteOrigin,
          title: WorkbenchProductName,
        },
      },
    })
    for (const providerId of ['velaros', 'velar-dev'] as const) {
      modelComposition.velarCloudRuntime.registerProvider(providerId, {
        baseURL: accountService.getManagedModelBaseUrl(providerId),
        fetch: (input, init) => accountService.fetchManagedModel(providerId, input, init),
      })
    }
    const disposeModelIpc = registerWorkbenchModelIpc(
      modelComposition.providerModelCatalogService,
      dataRootDir,
      accountService
    )
    // 本机 shell 宿主全应用共用：Agent 起的后台任务才能活过一轮运行；交互式命令跑在 node-pty 的真终端里。
    const shellHosts = new WorkbenchShellHostRegistry(shellEnvironment, loadWorkbenchShellTerminal)
    const syncAgentEdits = languageSyncOnAgentEdits(providers.language)
    // 长期记忆与网上查资料（与 Desktop 同一套）：记忆按项目各一份，查资料跑在不显示的页面里。
    const memory = new WorkbenchMemoryService(providers.parts.storagePaths.getMemoryDir())
    const webPages = new WorkbenchWebSearchPages()
    // Agent 浏览器（与 Desktop 同一套运行时）：运行时一个进程一份；页面发起的权限请求交给运行时变成模型处理的待办，
    // 无人管理的一律拒绝。
    const browserService = new WorkbenchBrowserService({
      createRuntime: (callbacks) =>
        createElectronBrowserRuntime({
          ...callbacks,
          registerPermissionRequestHandler: (electronSession, handler) =>
            registerWorkbenchBrowserRuntimePermissionHandler(electronSession, handler),
          resolvePermissionRequest: () => false,
          resolveUnmanagedPermissionRequest: () => false,
          selectWebAuthnAccount: async () => null,
        }),
      siteWorkspaceRoot: providers.parts.storagePaths.getBrowserSitesDir(),
      backgroundPages: new WorkbenchBrowserBackgroundPages(),
      resolveGuest: (webContentsId) => webContents.fromId(webContentsId) ?? null,
    })
    const nodePackagesDirectory = app.isPackaged
      ? join(process.resourcesPath, 'node-runtime')
      : undefined
    const platformConversationRuntime = createWorkbenchConversationRuntime({
      sessions: (request) => sessionPeers?.peers.forSession(request),
      nodeExecutable: resolveWorkbenchNodeExecutable(),
      nodePackagesDirectory,
      shells: shellHosts,
      dataDir: providers.parts.storagePaths.getConversationRuntimeDir(),
      configure: createWorkbenchConversationConfiguration(modelComposition.agentModelResolver),
      environment: () => WorkbenchHostEnvironment,
      // Agent 改项目的时间窗报给改动归属账本：「本轮改动」只认 Agent 的改动。
      activity: (ref) => providers.chatRunAttribution.activityFor(ref),
      // Agent 改完的文件当场告诉语言服务，别的文件里的诊断不等文件监听。
      projectFilesEdited: (ref, paths) => syncAgentEdits(ref.projectRoot, paths),
      projectRules: async (projectRoot) =>
        (await providers.workspace.projectRules(projectRoot)).files,
      memory: (workspace) => memory.forRun(workspace),
      webPages,
      browser: browserService,
    })
    // 外部引擎（本机装好的 Claude Code 与 Codex 命令行）：会话选了它们时由它们执行。
    const engineConversationRuntime = new WorkbenchEngineConversationRuntime({
      engines: [
        new ClaudeCodeEngine(shellEnvironment),
        new CodexEngine(shellEnvironment, app.getVersion()),
      ],
      sessions: new WorkbenchEngineSessionStore(dataRootDir),
      activity: (ref) => providers.chatRunAttribution.activityFor(ref),
      projectFilesEdited: (ref, paths) => syncAgentEdits(ref.projectRoot, paths),
    })
    const conversationRuntime = createWorkbenchConversationDispatcher(
      platformConversationRuntime,
      engineConversationRuntime
    )
    registerWorkbenchTerminalIpc(providers.parts.terminal)
    const disposeDebugIpc = registerWorkbenchDebugIpc(providers.parts.debug)
    registerWorkbenchGitIpc(providers.git, providers.chatCheckpoints, providers.chatRunChanges)
    const watchIpc = registerWorkbenchWatchIpc(providers.watch)
    const disposeWorkspaceIpc = registerWorkbenchWorkspaceIpc(providers.workspace)

    registerWorkbenchLanguageServiceIpc(
      providers.language,
      new WorkbenchInlineCompletionGenerator(undefined, modelComposition)
    )
    windowManager = new WorkbenchWindowManager(dataRootDir, {
      createBrowserWindow: createWorkbenchWindow,
      onLastProjectClosed: () => app.quit(),
      releaseProjectResources: async (ownerId, projectRoot) => {
        sessionPeers?.releaseProject(projectRoot)
        watchIpc.closeSubscriptionsForSender(ownerId)
        // 先断开这个窗口的调试会话，再结束它的终端会话（被调试的程序跑在里面）。
        const debugClosing = providers.parts.debug.closeSessionsForOwner(ownerId)
        await Promise.all([
          debugClosing,
          fsIpc.cancelCommandsForSender(ownerId),
          providers.parts.terminal.closeSessionsForOwner(ownerId),
          providers.language.invalidateProject({ projectRoot }),
          // 窗口关掉或切走项目：这个项目里还在跑的对话一并停下，浏览器页面一并离站。
          conversationRuntime.cancelProject(projectRoot),
          browserService.releaseProject(projectRoot),
          fsIpc.cancelContentSearchesForSender(ownerId),
        ])
      },
    })
    const sessionPeers = registerWorkbenchSessionPeersIpc({
      runtime: platformConversationRuntime,
      windows: windowManager,
    })
    const disposeConversationIpc = registerWorkbenchConversationIpc({
      runtime: conversationRuntime,
      windows: windowManager,
      backupDir: () => providers.parts.storagePaths.getChatHistoryBackupsDir(),
      analytics: productAnalytics,
    })
    const disposeAgentProcessesIpc = registerWorkbenchAgentProcessesIpc({
      shells: shellHosts,
      windows: windowManager,
      focusConsole: (ownerId) => agentConsoleWindows.focus(ownerId),
    })
    const disposeMemoryIpc = registerWorkbenchMemoryIpc({ memory, windows: windowManager })
    const disposeBrowserIpc = registerWorkbenchBrowserIpc({
      browser: browserService,
      windows: windowManager,
    })
    const fsIpc = registerWorkbenchFsIpc(
      providers.fileSystem,
      providers.parts,
      windowManager,
      withLanguageSyncOnUserWrites(providers.chatRunAttribution, providers.language)
    )
    registerProjectHubIpc(windowManager, new WorkbenchProjectRegistry(dataRootDir))
    registerWorkbenchWindowStateIpc()
    registerWorkbenchWindowCloseIpc(windowCloseGuard)
    let shutdownStarted = false
    app.on('before-quit', (event) => {
      if (shutdownStarted) return
      // 有未保存改动的窗口先存或问过用户：都答应了才开始收拾。先收拾再关窗的话，用户在确认框里点了
      // 取消，窗口还开着，IPC 与子进程却已经停了。
      if (windowCloseGuard.holdQuit()) {
        event.preventDefault()
        return
      }

      shutdownStarted = true
      event.preventDefault()
      // Electron 不等待 async listener：第一次 before-quit 必须拦住退出，待子进程与 worker
      // 真正收口后再触发第二次 quit；shutdownStarted 让第二次事件直接放行。
      watchIpc.dispose()
      workbenchBrowserWebviewGate?.dispose()
      workbenchBrowserWebviewGate = null
      disposeAccountIpc()
      disposeModelIpc()
      sessionPeers?.dispose()
      disposeConversationIpc()
      disposeAgentProcessesIpc()
      disposeMemoryIpc()
      disposeBrowserIpc()
      browserService.close()
      disposeWorkspaceIpc()
      disposeProductAnalyticsRuntime()
      disposeDebugIpc()
      void Promise.allSettled([
        fsIpc.cancelCommands(),
        providers.parts.debug.closeAllSessions(),
        providers.parts.terminal.closeAllSessions(),
        providers.language.dispose(),
        providers.workspace.dispose(),
        // 先停对话（运行时关闭时释放脚本子进程与存储），再停 Agent 起的后台任务。
        conversationRuntime.close().finally(() => shellHosts.dispose()),
        productAnalytics?.dispose(),
        fsIpc.cancelContentSearches(),
      ])
        .then((results) => {
          const failures = results.flatMap((result, index) =>
            result.status === 'rejected'
              ? [
                  {
                    operation: [
                      'commands', 'debug', 'terminal', 'language',
                      'workspace', 'conversation', 'analytics',
                      'searches',
                    ][index],
                    error: result.reason,
                  },
                ]
              : []
          )
          if (failures.length > 0) {
            Log.tag('WorkbenchShutdown').warn('shutdown_cleanup_failed', { failures })
          }
        })
        .finally(() => {
          disposeBrowserPermissionPolicy()
          app.quit()
        })
    })

    installWorkbenchUpdateRuntime()
    setWorkbenchSystemLanguageSource(() => app.getPreferredSystemLanguages()[0] ?? app.getLocale())
    installProjectHubMenu(windowManager)
    if (pendingExternalPaths.length > 0) {
      const paths = pendingExternalPaths.splice(0)
      void windowManager.openExternalPaths(paths)
    } else {
      windowManager.createWindow()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager?.createWindow()
      }
    })
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

export { createWorkbenchWindow }

function dispatchExternalPaths(paths: readonly string[]): void {
  const externalPaths = paths.filter((path) => validateExternalPathArgument(path))
  if (externalPaths.length === 0) return

  if (!windowManager) {
    pendingExternalPaths.push(...externalPaths)
    return
  }

  void windowManager.openExternalPaths(externalPaths)
}

function relaunchFromRequestedWorkbenchPackage(additionalData: unknown): boolean {
  const requested = parseWorkbenchInstanceLaunchData(additionalData)
  if (!requested) return false

  const currentExecutablePath = resolve(process.execPath)
  const requestedExecutablePath = resolve(requested.executablePath)
  if (requestedExecutablePath === currentExecutablePath) return false
  if (basename(requestedExecutablePath) !== basename(currentExecutablePath)) return false
  try {
    if (!statSync(requestedExecutablePath).isFile()) return false
  } catch {
    return false
  }

  const paths = [
    ...requested.externalPaths,
    ...(windowManager?.getOpenProjectPaths() ?? []),
  ].filter((path, index, values) => values.indexOf(path) === index)
  app.relaunch({ execPath: requestedExecutablePath, args: paths })
  app.quit()
  return true
}

function parseWorkbenchInstanceLaunchData(value: unknown): Nullable<WorkbenchInstanceLaunchData> {
  if (typeof value !== 'object' || value === null) return null
  const data = value as Partial<WorkbenchInstanceLaunchData>
  if (
    data.productName !== WorkbenchApplicationName ||
    typeof data.executablePath !== 'string' ||
    typeof data.version !== 'string' ||
    !Array.isArray(data.externalPaths) ||
    !data.externalPaths.every((path) => typeof path === 'string')
  )
    return null

  return {
    productName: WorkbenchApplicationName,
    executablePath: data.executablePath,
    version: data.version,
    externalPaths: data.externalPaths.filter((path) => validateExternalPathArgument(path)),
  }
}

function collectExternalPathArguments(
  argv: readonly string[],
  workingDirectory = process.cwd()
): string[] {
  const userArguments = argv.slice(app.isPackaged ? 1 : 2)
  const paths: string[] = []
  const seen = new Set<string>()

  for (const argument of userArguments) {
    if (!argument || argument.startsWith('-')) continue
    const path = resolve(workingDirectory, argument)
    if (seen.has(path) || !validateExternalPathArgument(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function validateExternalPathArgument(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}
