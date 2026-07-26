import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { WorkbenchKernelClientRuntime } from './kernel/WorkbenchKernelClientRuntime'
import { registerWorkbenchKernelIpc } from './kernel/WorkbenchKernelIpc'
import { WorkbenchStandaloneKernelRuntime } from './kernel/WorkbenchStandaloneKernelRuntime'
import { WorkbenchProjectHub } from './projects/ProjectHub'
import { registerProjectHubIpc } from './projects/ProjectHubIpc'
import { installProjectHubMenu } from './projects/ProjectHubMenu'
import { LanguageGrammarInstaller } from './resources/LanguageGrammarInstaller'
import { registerLanguageGrammarIpc } from './resources/LanguageGrammarIpc'
import {
  registerLanguageGrammarProtocol,
  registerLanguageGrammarScheme,
} from './resources/languageGrammarProtocol'
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
 * 负责窗口生命周期 + 项目枢纽（起手页三主动作 / 最近项目持久化 / 窗口标题与菜单跟随项目状态）。
 * IDE 本地能力由应用私有 IPC 语义端口承载；共享能力通过经过认证的 Kernel daemon
 * 客户端组合根接入，不反向依赖 Desktop。优先连接现有 daemon；daemon 缺席时由 Workbench
 * 启动同一套 Kernel 模块组合，并继续通过本地 RPC 使用它，避免产生第二套运行时语义。
 *
 * 数据根对齐 Desktop 惯例（prod=userData，dev=cwd/.data 隔离目录），但完全独立于 Desktop 的
 * chat 存储：应用名固定 `VelarOS Workbench`，prod userData 因此拥有自己的平台目录。
 */
const WorkbenchProductName = 'VelarOS Workbench'
const WorkbenchWindowWidth = 1280
const WorkbenchWindowHeight = 800

app.setName(WorkbenchProductName)
registerLanguageGrammarScheme()

function resolveWorkbenchDataRootDir(): string {
  const isDevelopment = process.env['NODE_ENV'] === 'development' || !app.isPackaged
  return isDevelopment
    ? join(process.cwd(), '.data', 'workbench-app')
    : app.getPath('userData')
}

function getWorkbenchWindowTitle(projectName: Nullable<string>): string {
  return projectName ?? WorkbenchProductName
}

function createWorkbenchWindow(hub: WorkbenchProjectHub): void {
  const window = new BrowserWindow({
    width: WorkbenchWindowWidth,
    height: WorkbenchWindowHeight,
    show: false,
    title: getWorkbenchWindowTitle(hub.getState().currentProject?.name ?? null),
    webPreferences: {
      sandbox: false,
      // electron-vite 对 type:module 应用输出 ESM preload（.mjs）。
      preload: join(__dirname, '../preload/index.mjs'),
    },
  })

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
}

/**
 * 语言服务 worker 的生命周期跟项目根：项目切换/关闭时释放上一根的 tsserver 建图缓存。
 * worker 惰性拉起（首个语言请求时），未起时 `invalidateProject` 为 no-op。
 */
function installLanguageServiceProjectLifecycle(
  hub: WorkbenchProjectHub,
  client: ReturnType<typeof createDefaultWorkbenchMainCapabilityProviders>['language']
): void {
  let activeProjectRoot = hub.getState().currentProject?.path ?? null

  hub.onStateChanged((state) => {
    const nextProjectRoot = state.currentProject?.path ?? null
    if (nextProjectRoot === activeProjectRoot) return

    if (activeProjectRoot) void client.invalidateProject({ projectRoot: activeProjectRoot })
    activeProjectRoot = nextProjectRoot
  })
}

void app.whenReady().then(() => {
  const dataRootDir = resolveWorkbenchDataRootDir()
  const hub = new WorkbenchProjectHub(dataRootDir)
  registerProjectHubIpc(hub)
  const providers = createDefaultWorkbenchMainCapabilityProviders(dataRootDir)
  const kernelRuntime = new WorkbenchKernelClientRuntime({
    requiredCapabilityIds: [...new Set(
      Object.values(providers.kernelRoutes).map((route) => route.capabilityId)
    )],
    startLocal: async () => {
      const standaloneKernel = new WorkbenchStandaloneKernelRuntime({
        workspace: providers.workspace,
        isWorkspaceRootAllowed: (projectRoot) =>
          hub.getState().currentProject?.path === projectRoot,
      })
      await standaloneKernel.start()
      return standaloneKernel
    },
  })
  const disposeKernelIpc = registerWorkbenchKernelIpc(
    kernelRuntime,
    providers.kernelRoutes
  )
  void kernelRuntime.start()
  const languageGrammarInstaller = new LanguageGrammarInstaller({
    installRoot: () => providers.parts.storagePaths.getLanguageGrammarsDir(),
  })
  registerLanguageGrammarProtocol(languageGrammarInstaller)
  const disposeLanguageGrammarIpc = registerLanguageGrammarIpc(languageGrammarInstaller)
  registerWorkbenchFsIpc(providers.fileSystem, providers.parts)
  registerWorkbenchTerminalIpc(providers.parts.terminal)
  registerWorkbenchGitIpc(providers.git)
  const disposeWatchIpc = registerWorkbenchWatchIpc(providers.watch)
  const disposeWorkspaceIpc = registerWorkbenchWorkspaceIpc(providers.workspace)

  registerWorkbenchLanguageServiceIpc(providers.language)
  installLanguageServiceProjectLifecycle(hub, providers.language)
  let shutdownStarted = false
  app.on('before-quit', (event) => {
    if (shutdownStarted) return

    shutdownStarted = true
    event.preventDefault()
    // Electron 不等待 async listener：第一次 before-quit 必须拦住退出，待子进程与 worker
    // 真正收口后再触发第二次 quit；shutdownStarted 让第二次事件直接放行。
    disposeWatchIpc()
    disposeLanguageGrammarIpc()
    disposeKernelIpc()
    disposeWorkspaceIpc()
    void Promise.all([
      providers.parts.terminal.closeAllSessions(),
      providers.language.dispose(),
      providers.workspace.dispose(),
      kernelRuntime.dispose(),
    ]).finally(() => app.quit())
  })

  installProjectHubMenu(hub)
  createWorkbenchWindow(hub)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWorkbenchWindow(hub)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

export { createWorkbenchWindow }
