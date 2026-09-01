import { statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { app, BrowserWindow, shell } from 'electron'

import { createAgentKernelModule } from '@velaros-ai/agent'
import { Log } from '@velaros-ai/core'
import { Kernel } from '@velaros-ai/kernel/runtime'
import { ProviderModelCatalogService } from '@velaros-ai/model'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

import productionAppIconPath from '../../build/icon.png?asset'
import developmentAppIconPath from '../../build/icon-dev.png?asset'

import { registerWorkbenchAccountIpc } from './account/WorkbenchAccountIpc'
import { WorkbenchAccountService } from './account/WorkbenchAccountService'
import { WorkbenchSharedAccountStore } from './account/WorkbenchSharedAccountStore'
import { WorkbenchAgentExecutionStack } from './agent/WorkbenchAgentExecutionStack'
import { WorkbenchProductAnalyticsReporter } from './analytics/WorkbenchProductAnalyticsReporter'
import { installWorkbenchProductAnalyticsRuntime } from './analytics/WorkbenchProductAnalyticsRuntime'
import { WorkbenchAgentCapabilityRuntime } from './kernel/WorkbenchAgentCapabilityRuntime'
import {
  broadcastWorkbenchKernelStatus,
  registerWorkbenchKernelIpc,
} from './kernel/WorkbenchKernelIpc'
import { WorkbenchKernelPermissionPolicy } from './kernel/WorkbenchKernelPermissionPolicy'
import { registerWorkbenchModelIpc } from './model/WorkbenchModelIpc'
import type { WorkbenchProjectHub } from './projects/ProjectHub'
import { registerProjectHubIpc } from './projects/ProjectHubIpc'
import { installProjectHubMenu } from './projects/ProjectHubMenu'
import { installWorkbenchEditorZoom } from './projects/WorkbenchEditorZoom'
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
 * 不反向依赖 Desktop。Workbench 只自持 Agent 能力，model / browser 没有本体因此不注册，
 * 消费面按能力缺席降级。
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
      // electron-vite 对 type:module 应用输出 ESM preload（.mjs）。
      preload: join(__dirname, '../preload/index.mjs'),
    },
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
  // 进程内 Kernel：只注册 Workbench 自持的 Agent 能力，执行栈也在本进程。
  const agentExecutionStack = new WorkbenchAgentExecutionStack(
    providers.workspace,
    modelComposition
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
    dataRootDir
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
  const disposeKernelIpc = registerWorkbenchKernelIpc(
    kernelRuntime,
    providers.kernelRoutes,
    providers.parts.storagePaths,
    (sessionId, answer) => providers.agentEngines.resolveInput(sessionId, answer),
    (sessionId, approved, rejectionMessage) =>
      providers.agentEngines.resolveConfirmation(sessionId, approved, rejectionMessage)
  )
  void kernelRuntime.start().finally(() => {
    broadcastWorkbenchKernelStatus(kernelRuntime)
  })
  const disposeResourcePluginIpc = registerWorkbenchResourcePluginIpc(
    providers.resourcePlugins
  )
  registerWorkbenchFsIpc(providers.fileSystem, providers.parts)
  registerWorkbenchTerminalIpc(providers.parts.terminal)
  registerWorkbenchGitIpc(providers.git)
  const watchIpc = registerWorkbenchWatchIpc(providers.watch)
  const disposeWorkspaceIpc = registerWorkbenchWorkspaceIpc(providers.workspace)

  registerWorkbenchLanguageServiceIpc(
    providers.language,
    new WorkbenchInlineCompletionGenerator()
  )
  windowManager = new WorkbenchWindowManager(dataRootDir, {
    createBrowserWindow: createWorkbenchWindow,
    onLastProjectClosed: () => app.quit(),
    releaseProjectResources: async (ownerId, projectRoot) => {
      watchIpc.closeSubscriptionsForSender(ownerId)
      await Promise.all([
        providers.parts.terminal.closeSessionsForOwner(ownerId),
        providers.language.invalidateProject({ projectRoot }),
      ])
    },
  })
  registerProjectHubIpc(windowManager)
  let shutdownStarted = false
  app.on('before-quit', (event) => {
    if (shutdownStarted) return

    shutdownStarted = true
    event.preventDefault()
    // Electron 不等待 async listener：第一次 before-quit 必须拦住退出，待子进程与 worker
    // 真正收口后再触发第二次 quit；shutdownStarted 让第二次事件直接放行。
    watchIpc.dispose()
    disposeResourcePluginIpc()
    disposeAccountIpc()
    disposeModelIpc()
    disposeKernelIpc()
    disposeWorkspaceIpc()
    disposeProductAnalyticsRuntime()
    void Promise.all([
      providers.parts.terminal.closeAllSessions(),
      providers.language.dispose(),
      providers.workspace.dispose(),
      kernelRuntime.dispose(),
      productAnalytics?.dispose(),
    ]).finally(() => app.quit())
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
