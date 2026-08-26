import { statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { app, BrowserWindow, shell } from 'electron'

import { createAgentKernelModule } from '@velaros-ai/agent'
import { Log } from '@velaros-ai/core'
import { Kernel } from '@velaros-ai/kernel/runtime'

import productionAppIconPath from '../../build/icon.png?asset'
import developmentAppIconPath from '../../build/icon-dev.png?asset'

import { WorkbenchAgentExecutionStack } from './agent/WorkbenchAgentExecutionStack'
import { WorkbenchAgentCapabilityRuntime } from './kernel/WorkbenchAgentCapabilityRuntime'
import {
  broadcastWorkbenchKernelStatus,
  registerWorkbenchKernelIpc,
} from './kernel/WorkbenchKernelIpc'
import { WorkbenchKernelPermissionPolicy } from './kernel/WorkbenchKernelPermissionPolicy'
import { registerWorkbenchModIpc } from './mods/WorkbenchModIpc'
import type { WorkbenchProjectHub } from './projects/ProjectHub'
import { registerProjectHubIpc } from './projects/ProjectHubIpc'
import { installProjectHubMenu } from './projects/ProjectHubMenu'
import { installWorkbenchEditorZoom } from './projects/WorkbenchEditorZoom'
import { WorkbenchWindowManager } from './projects/WorkbenchWindowManager'
import { registerWorkbenchResourcePluginIpc } from './resources/WorkbenchResourcePluginIpc'
import { registerWorkbenchGitIpc } from './workspace/git/WorkbenchGitIpc'
import { WorkbenchInlineCompletionGenerator } from './workspace/language/WorkbenchInlineCompletion'
import { registerWorkbenchLanguageServiceIpc } from './workspace/language/WorkbenchLanguageServiceIpc'
import { registerWorkbenchTerminalIpc } from './workspace/terminal/WorkbenchTerminalIpc'
import { registerWorkbenchWatchIpc } from './workspace/watch/WorkbenchWatchIpc'
import { registerWorkbenchFsIpc } from './workspace/WorkbenchFsIpc'
import { registerWorkbenchWorkspaceIpc } from './workspace/WorkbenchWorkspaceIpc'
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
 * 数据根对齐 Desktop 惯例（prod=userData，dev=cwd/.data 隔离目录），但完全独立于 Desktop 的
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
  projectPaths: string[]
}

app.setName(WorkbenchApplicationName)
if (WorkbenchIsDevelopmentRuntime) {
  app.setPath('userData', join(process.cwd(), '.data', 'workbench-app'))
}

let windowManager: Nullable<WorkbenchWindowManager> = null
const pendingExternalProjectPaths = collectProjectDirectoryArguments(process.argv)

app.on('open-file', (event, path) => {
  event.preventDefault()
  dispatchExternalProjectPaths([path])
})

const instanceLaunchData: WorkbenchInstanceLaunchData = {
  productName: WorkbenchApplicationName,
  executablePath: process.execPath,
  version: app.getVersion(),
  projectPaths: pendingExternalProjectPaths,
}
const hasSingleInstanceLock = app.requestSingleInstanceLock(instanceLaunchData)
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    if (relaunchFromRequestedWorkbenchPackage(additionalData)) return

    const paths = collectProjectDirectoryArguments(argv, workingDirectory)
    if (paths.length > 0) {
      dispatchExternalProjectPaths(paths)
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
    icon: WorkbenchApplicationIconPath,
    show: false,
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

if (hasSingleInstanceLock) void app.whenReady().then(() => {
  if (WorkbenchIsDevelopmentRuntime) app.dock?.setIcon(WorkbenchApplicationIconPath)
  const dataRootDir = resolveWorkbenchDataRootDir()
  const providers = createDefaultWorkbenchMainCapabilityProviders(
    dataRootDir,
    (url) => shell.openExternal(url)
  )
  // 进程内 Kernel：只注册 Workbench 自持的 Agent 能力，执行栈也在本进程。
  const agentExecutionStack = new WorkbenchAgentExecutionStack(providers.workspace)
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
      runtime: new WorkbenchAgentCapabilityRuntime(agentExecutionStack, providers.agentEngines),
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
  const disposeModIpc = registerWorkbenchModIpc(providers.mods)
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
    disposeModIpc()
    disposeKernelIpc()
    disposeWorkspaceIpc()
    void Promise.all([
      providers.parts.terminal.closeAllSessions(),
      providers.language.dispose(),
      providers.workspace.dispose(),
      kernelRuntime.dispose(),
    ]).finally(() => app.quit())
  })

  installProjectHubMenu(windowManager)
  if (pendingExternalProjectPaths.length > 0) {
    const paths = pendingExternalProjectPaths.splice(0)
    void windowManager.openExternalProjectPaths(paths)
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

function dispatchExternalProjectPaths(paths: readonly string[]): void {
  const projectPaths = paths.filter((path) => validateProjectDirectoryArgument(path))
  if (projectPaths.length === 0) return

  if (!windowManager) {
    pendingExternalProjectPaths.push(...projectPaths)
    return
  }

  void windowManager.openExternalProjectPaths(projectPaths)
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
    ...requested.projectPaths,
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
    !Array.isArray(data.projectPaths) ||
    !data.projectPaths.every((path) => typeof path === 'string')
  ) return null

  return {
    productName: WorkbenchApplicationName,
    executablePath: data.executablePath,
    version: data.version,
    projectPaths: data.projectPaths.filter((path) => validateProjectDirectoryArgument(path)),
  }
}

function collectProjectDirectoryArguments(
  argv: readonly string[],
  workingDirectory = process.cwd()
): string[] {
  const userArguments = argv.slice(app.isPackaged ? 1 : 2)
  const paths: string[] = []
  const seen = new Set<string>()

  for (const argument of userArguments) {
    if (!argument || argument.startsWith('-')) continue
    const path = resolve(workingDirectory, argument)
    if (seen.has(path) || !validateProjectDirectoryArgument(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function validateProjectDirectoryArgument(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
