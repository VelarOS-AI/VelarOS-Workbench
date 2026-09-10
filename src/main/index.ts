import { statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { app, BrowserWindow, session, shell, webContents } from 'electron'

import { createAgentKernelModule } from '@velaros-ai/agent'
import {
  createBrowserKernelModule,
  ElectronBrowserRuntime,
} from '@velaros-ai/browser/runtime'
import { Log } from '@velaros-ai/core'
import { Kernel } from '@velaros-ai/kernel/runtime'
import { ProviderModelCatalogService } from '@velaros-ai/model'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

import productionAppIconPath from '../../build/icon.png?asset'
import developmentAppIconPath from '../../build/icon-dev.png?asset'
import { WorkbenchBrowserPartition } from '../shared/workbenchBrowser'

import { registerWorkbenchAccountIpc } from './account/WorkbenchAccountIpc'
import { WorkbenchAccountService } from './account/WorkbenchAccountService'
import { WorkbenchSharedAccountStore } from './account/WorkbenchSharedAccountStore'
import { WorkbenchAgentExecutionStack } from './agent/WorkbenchAgentExecutionStack'
import { WorkbenchProductAnalyticsReporter } from './analytics/WorkbenchProductAnalyticsReporter'
import { installWorkbenchProductAnalyticsRuntime } from './analytics/WorkbenchProductAnalyticsRuntime'
import { registerWorkbenchBrowserIpc } from './browser/WorkbenchBrowserIpc'
import { installWorkbenchBrowserDefaultPermissionPolicy } from './browser/WorkbenchBrowserPermissionPolicy'
import { WorkbenchBrowserToolHost } from './browser/WorkbenchBrowserToolHost'
import { WorkbenchBrowserWebviewGate } from './browser/WorkbenchBrowserWebviewGate'
import { WorkbenchAgentCapabilityRuntime } from './kernel/WorkbenchAgentCapabilityRuntime'
import {
  broadcastWorkbenchKernelStatus,
  registerWorkbenchKernelIpc,
} from './kernel/WorkbenchKernelIpc'
import { WorkbenchKernelPermissionPolicy } from './kernel/WorkbenchKernelPermissionPolicy'
import { registerWorkbenchModelIpc } from './model/WorkbenchModelIpc'
import { registerWorkbenchModIpc } from './mods/WorkbenchModIpc'
import { WorkbenchModService } from './mods/WorkbenchModService'
import type { WorkbenchProjectHub } from './projects/ProjectHub'
import { registerProjectHubIpc } from './projects/ProjectHubIpc'
import { installProjectHubMenu } from './projects/ProjectHubMenu'
import { installWorkbenchEditorZoom } from './projects/WorkbenchEditorZoom'
import { installWorkbenchExternalNavigation } from './projects/WorkbenchExternalNavigation'
import {
  normalizeWorkbenchInternalBrowserUrl,
  prepareWorkbenchWebviewAttachment,
} from './projects/WorkbenchWebviewSecurity'
import { WorkbenchWindowManager } from './projects/WorkbenchWindowManager'
import { registerWorkbenchResourcePluginIpc } from './resources/WorkbenchResourcePluginIpc'
import { installWorkbenchUpdateRuntime } from './updates/WorkbenchUpdateRuntime'
import { registerWorkbenchGitIpc } from './workspace/git/WorkbenchGitIpc'
import { WorkbenchInlineCompletionGenerator } from './workspace/language/WorkbenchInlineCompletion'
import { registerWorkbenchLanguageServiceIpc } from './workspace/language/WorkbenchLanguageServiceIpc'
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
 * IDE 本地能力由应用私有 IPC 语义端口承载；共享能力走**进程内 Kernel**
 * （kernel-contract §15：完整宿主进程内装栈，不经 client 子路径、不拉 daemon），
 * 不反向依赖 Desktop。Workbench 自持 Agent 与 Browser Mod 能力；Model 仍由宿主组合后直接
 * 注入 Agent，不额外发布可被 renderer 任意调用的 Kernel 能力。
 *
 * 数据根对齐 Desktop 惯例（prod=userData，dev=cwd/.velaros/data 隔离目录），但完全独立于 Desktop 的
 * chat 存储：应用名固定 `VelarOS Workbench`，prod userData 因此拥有自己的平台目录。
 */
const WorkbenchProductName = 'VelarOS Workbench'
const WorkbenchWindowWidth = 1280
const WorkbenchWindowHeight = 800

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
  return projectName ?? WorkbenchApplicationName
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
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
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
    }
  )
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (
      !workbenchBrowserWebviewGate?.allowsAttachment()
      || !prepareWorkbenchWebviewAttachment(webPreferences, params)
    ) event.preventDefault()
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
      if (!normalizeWorkbenchInternalBrowserUrl(url)) event.preventDefault()
    })
  })
  installWorkbenchEditorZoom(window)

  // 窗口标题唯一权威在 main（跟随项目状态）；拦掉页面 <title> 的默认回写，避免双权威打架。
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

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
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
    ...(productAnalytics ? { reporter: productAnalytics } : {}),
  })
  const accountService = new WorkbenchAccountService(
      new WorkbenchSharedAccountStore(),
      (url) => shell.openExternal(url)
  )
  const disposeAccountIpc = registerWorkbenchAccountIpc(accountService)
  const modService = new WorkbenchModService(dataRootDir)
  const disposeModIpc = registerWorkbenchModIpc(modService)
  workbenchBrowserWebviewGate = new WorkbenchBrowserWebviewGate(modService)
  const browserRuntime = new ElectronBrowserRuntime()
  const browserHost = new WorkbenchBrowserToolHost({
    dataRootDir,
    modState: modService,
    runtime: browserRuntime,
    isProjectRootOwned: (projectRoot) =>
      windowManager?.getOpenProjectPaths().includes(projectRoot) === true,
    resolveGuestWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  })
  productAnalytics?.start()
  const providers = createDefaultWorkbenchMainCapabilityProviders(
    dataRootDir,
    (url) => shell.openExternal(url),
    {
      artifactBase: () => accountService.getPluginArtifactBaseUrl(),
      fetchImpl: (input) => accountService.fetchPluginResource(new URL(input.toString())),
    },
    app.getVersion()
  )
  const modelComposition = createModelRuntimeComposition()
  modelComposition.velarCloudRuntime.registerProvider('velar', {
    baseURL: accountService.getManagedModelBaseUrl('velar'),
    fetch: (input, init) => accountService.fetchManagedModel('velar', input, init),
  })
  modelComposition.velarCloudRuntime.registerProvider('velar-dev', {
    baseURL: accountService.getManagedModelBaseUrl('velar-dev'),
    fetch: (input, init) => accountService.fetchManagedModel('velar-dev', input, init),
  })
  // Browser Mod 每轮发布一份冻结工具面；页面 URL/标题/加载态使用独立 revision，不会
  // 重建 Agent 会话。每次具体执行仍由 Browser Host 实时校验启用态与项目所有权。
  const agentExecutionStack = new WorkbenchAgentExecutionStack(
    providers.workspace,
    modelComposition,
    {
      captureSnapshot: ({ sessionId, projectRoot }) => {
        const snapshot = browserHost.getModSurfaceSnapshot(sessionId, projectRoot)
        return {
          generation: snapshot.generation,
          tools: snapshot.tools,
          categoryDefinitions: snapshot.categoryDefinitions,
          enabledCategoryIds: snapshot.enabledCategoryIds,
          residentCategoryIds: snapshot.residentCategoryIds,
          initialVisibleToolNames: snapshot.initialVisibleToolNames,
        }
      },
    },
    // 子 Agent 在托管厂商下可选的模型 = 当前账号授权目录里可用的那些（与模型选择器同一来源）。
    // 账号接口读不到时回 null：派发照常进行，调度器按原样透传指定的模型。
    async (providerId) => {
      const access = await accountService.getManagedModelAccess().catch((error: unknown) => {
        Log.tag('WorkbenchTeamModelRouting').warn('managed_model_access_failed', {
          providerId,
          error: String(error),
        })
        return null
      })
      const provider = access?.managedModels.find((entry) => entry.providerId === providerId)
      const models = provider?.enabled
        ? provider.models
            .filter((model) => model.status === 'available')
            .map(({ id, label }) => ({ id, label }))
        : []
      return models.length > 0 ? models : null
    }
  )
  const disposeModelIpc = registerWorkbenchModelIpc(
    new ProviderModelCatalogService({
      providerCollection: modelComposition.providerCollection,
      providerScriptRegistry: modelComposition.providerScriptRegistry,
      attribution: {
        referer: websiteOrigin,
        title: WorkbenchProductName,
      },
    }),
    dataRootDir,
    accountService
  )
  const kernelRuntime = new Kernel({
    lifecycleFailureMode: 'degrade',
    permissionBroker: new WorkbenchKernelPermissionPolicy(),
    onLifecycleFailure: ({ phase, error }) => {
      Log.tag('WorkbenchKernel').warn(`kernel.${phase}_failed`, {
        error: error.message,
        hint: phase === 'start'
          ? 'Workbench continues without in-process Kernel capabilities; dependent surfaces stay inactive.'
          : 'Workbench shutdown continues after Kernel capability cleanup failure.',
      })
    },
  })
  kernelRuntime.registerModule(
    createAgentKernelModule({
      runtime: new WorkbenchAgentCapabilityRuntime(
        agentExecutionStack,
        providers.agentEngines,
        productAnalytics
      ),
    })
  )
  kernelRuntime.registerModule(
    createBrowserKernelModule({
      runtime: browserRuntime,
      disposeInjectedRuntime: false,
    })
  )
  const disposeKernelIpc = registerWorkbenchKernelIpc(
    kernelRuntime,
    providers.kernelRoutes,
    providers.parts.storagePaths,
    (sessionId, answer) => providers.agentEngines.resolveInput(sessionId, answer),
    // 确认回执按会话找等待方：外部引擎与原生执行栈各自持有一张挂起表，命中谁就由谁结算。
    // 两条链路共用同一条 IPC 协议，renderer 不需要知道当前会话跑的是哪个执行体。
    (sessionId, approved, rejectionMessage) =>
      providers.agentEngines.resolveConfirmation(sessionId, approved, rejectionMessage)
      || agentExecutionStack.approvals.resolve(sessionId, approved, rejectionMessage),
    // 运行中补发的引导只有原生执行栈能接（外部引擎没有中途注入语义），不命中就回 false。
    { provideAgentGuidance: (request) => agentExecutionStack.provideGuidance(request) }
  )
  void kernelRuntime.start().finally(() => {
    broadcastWorkbenchKernelStatus(kernelRuntime)
  })
  const disposeResourcePluginIpc = registerWorkbenchResourcePluginIpc(
    providers.resourcePlugins
  )
  registerWorkbenchTerminalIpc(providers.parts.terminal)
  registerWorkbenchGitIpc(providers.git, providers.chatCheckpoints)
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
      watchIpc.closeSubscriptionsForSender(ownerId)
      await Promise.all([
        providers.parts.terminal.closeSessionsForOwner(ownerId),
        providers.language.invalidateProject({ projectRoot }),
        browserHost.releaseProject(projectRoot),
      ])
    },
  })
  const disposeBrowserIpc = registerWorkbenchBrowserIpc(browserHost, windowManager)
  registerWorkbenchFsIpc(providers.fileSystem, providers.parts, windowManager)
  registerProjectHubIpc(windowManager)
  let shutdownStarted = false
  app.on('before-quit', (event) => {
    if (shutdownStarted) return

    shutdownStarted = true
    event.preventDefault()
    // Electron 不等待 async listener：第一次 before-quit 必须拦住退出，待子进程与 worker
    // 真正收口后再触发第二次 quit；shutdownStarted 让第二次事件直接放行。
    watchIpc.dispose()
    workbenchBrowserWebviewGate?.dispose()
    workbenchBrowserWebviewGate = null
    disposeBrowserIpc()
    disposeResourcePluginIpc()
    disposeAccountIpc()
    disposeModIpc()
    modService.dispose()
    disposeModelIpc()
    disposeKernelIpc()
    disposeWorkspaceIpc()
    disposeProductAnalyticsRuntime()
    void Promise.allSettled([
      providers.parts.terminal.closeAllSessions(),
      providers.language.dispose(),
      providers.workspace.dispose(),
      kernelRuntime.dispose(),
      productAnalytics?.dispose(),
    ]).then((results) => {
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{ operation: ['terminal', 'language', 'workspace', 'kernel', 'analytics'][index], error: result.reason }]
          : []
      )
      if (failures.length > 0) {
        Log.tag('WorkbenchShutdown').warn('shutdown_cleanup_failed', { failures })
      }
    }).finally(() => {
      browserHost.dispose()
      disposeBrowserPermissionPolicy()
      app.quit()
    })
  })

  installWorkbenchUpdateRuntime()
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
  ) return null

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
