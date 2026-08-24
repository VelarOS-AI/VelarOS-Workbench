import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { createAgentKernelModule } from '@velaros-ai/agent'
import { AgentCapabilityApiVersion } from '@velaros-ai/agent/protocol/agent-capability'
import { Log } from '@velaros-ai/core'
import { KernelVersion } from '@velaros-ai/kernel/contracts/abi'
import { Kernel } from '@velaros-ai/kernel/runtime'

import { WorkbenchAgentExecutionStack } from './agent/WorkbenchAgentExecutionStack'
import { WorkbenchAgentCapabilityRuntime } from './kernel/WorkbenchAgentCapabilityRuntime'
import { registerWorkbenchAgentModIpc } from './kernel/WorkbenchAgentModIpc'
import {
  createWorkbenchAgentModPackReader,
  WorkbenchAgentModPackStore,
} from './kernel/WorkbenchAgentModPackStore'
import { WorkbenchAgentModRuntime } from './kernel/WorkbenchAgentModRuntime'
import {
  broadcastWorkbenchKernelStatus,
  registerWorkbenchKernelIpc,
} from './kernel/WorkbenchKernelIpc'
import { WorkbenchKernelPermissionPolicy } from './kernel/WorkbenchKernelPermissionPolicy'
import { WorkbenchModService } from './kernel/WorkbenchModService'
import type { WorkbenchProjectHub } from './projects/ProjectHub'
import { registerProjectHubIpc } from './projects/ProjectHubIpc'
import { installProjectHubMenu } from './projects/ProjectHubMenu'
import { installWorkbenchEditorZoom } from './projects/WorkbenchEditorZoom'
import { WorkbenchWindowManager } from './projects/WorkbenchWindowManager'
import { registerWorkbenchGitIpc } from './workspace/git/WorkbenchGitIpc'
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

app.setName(WorkbenchProductName)

let windowManager: Nullable<WorkbenchWindowManager> = null
const pendingExternalProjectPaths = collectProjectDirectoryArguments(process.argv)

app.on('open-file', (event, path) => {
  event.preventDefault()
  dispatchExternalProjectPaths([path])
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const paths = collectProjectDirectoryArguments(argv, workingDirectory)
    if (paths.length > 0) {
      dispatchExternalProjectPaths(paths)
      return
    }

    windowManager?.activateOrCreateWindow()
  })
}

function resolveWorkbenchDataRootDir(): string {
  const isDevelopment = process.env['NODE_ENV'] === 'development' || !app.isPackaged
  return isDevelopment
    ? join(process.cwd(), '.data', 'workbench-app')
    : app.getPath('userData')
}

function getWorkbenchWindowTitle(projectName: Nullable<string>): string {
  return projectName ?? WorkbenchProductName
}

function createWorkbenchWindow(hub: WorkbenchProjectHub): BrowserWindow {
  const window = new BrowserWindow({
    width: WorkbenchWindowWidth,
    height: WorkbenchWindowHeight,
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
  const dataRootDir = resolveWorkbenchDataRootDir()
  const providers = createDefaultWorkbenchMainCapabilityProviders(dataRootDir)
  // 两级注册机的宿主侧接缝：Loader 构造期就位（seam 派发器必须早于执行栈装配），
  // 启动后由 mod 门面用一份**本地** pack 清单装载一次。
  const agentModRuntime = new WorkbenchAgentModRuntime({
    versions: {
      velarosVersion: KernelVersion,
      agentApiVersion: AgentCapabilityApiVersion,
      shellVersion: app.getVersion(),
    },
    reader: createWorkbenchAgentModPackReader(),
  })
  const modService = new WorkbenchModService(
    new WorkbenchAgentModPackStore(
      providers.parts.storagePaths.getModPacksDir(),
      providers.parts.storagePaths.getModRegistryPath()
    ),
    agentModRuntime
  )
  const disposeAgentModIpc = registerWorkbenchAgentModIpc(modService)
  // 进程内 Kernel：只注册 Workbench 自持的 Agent 能力，执行栈也在本进程。
  const agentExecutionStack = new WorkbenchAgentExecutionStack(
    providers.workspace,
    agentModRuntime.seams
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
      runtime: new WorkbenchAgentCapabilityRuntime(agentExecutionStack),
    })
  )
  const disposeKernelIpc = registerWorkbenchKernelIpc(
    kernelRuntime,
    providers.kernelRoutes,
    providers.parts.storagePaths
  )
  void kernelRuntime
    .start()
    .then(() => modService.assembleAgentAxis())
    .finally(() => {
      broadcastWorkbenchKernelStatus(kernelRuntime)
    })
  registerWorkbenchFsIpc(providers.fileSystem, providers.parts)
  registerWorkbenchTerminalIpc(providers.parts.terminal)
  registerWorkbenchGitIpc(providers.git)
  const watchIpc = registerWorkbenchWatchIpc(providers.watch)
  const disposeWorkspaceIpc = registerWorkbenchWorkspaceIpc(providers.workspace)

  registerWorkbenchLanguageServiceIpc(providers.language)
  windowManager = new WorkbenchWindowManager(dataRootDir, {
    createBrowserWindow: createWorkbenchWindow,
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
    disposeAgentModIpc()
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
