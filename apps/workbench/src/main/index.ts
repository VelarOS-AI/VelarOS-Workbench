import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

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
import { WorkbenchGitService } from './workspace/git/WorkbenchGitService'
import { WorkbenchLanguageServiceWorkerClient } from './workspace/language/LanguageServiceWorkerClient'
import { registerWorkbenchLanguageServiceIpc } from './workspace/language/WorkbenchLanguageServiceIpc'
import { createWorkbenchAppParts } from './workspace/Parts'
import { registerWorkbenchTerminalIpc } from './workspace/terminal/WorkbenchTerminalIpc'
import { WorkbenchFileWatcher } from './workspace/watch/WorkbenchFileWatcher'
import { registerWorkbenchWatchIpc } from './workspace/watch/WorkbenchWatchIpc'
import { registerWorkbenchFsIpc } from './workspace/WorkbenchFsIpc'
import { WorkbenchProjectFileSystem } from './workspace/WorkbenchProjectFileSystem'

/**
 * 独立 VelarOS Workbench 应用的主进程。
 *
 * 负责窗口生命周期 + 项目枢纽（起手页三主动作 / 最近项目持久化 / 窗口标题与菜单跟随项目状态）。
 * IDE 本地能力由应用私有 IPC 语义端口承载；需要 Agent/模型的能力保留在 Workbench Host
 * 契约上，等待共享 Kernel RPC 装配，不反向依赖 Desktop。
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
  client: WorkbenchLanguageServiceWorkerClient
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
  const parts = createWorkbenchAppParts(dataRootDir)
  const languageGrammarInstaller = new LanguageGrammarInstaller({
    installRoot: () => parts.storagePaths.getLanguageGrammarsDir(),
  })
  registerLanguageGrammarProtocol(languageGrammarInstaller)
  const disposeLanguageGrammarIpc = registerLanguageGrammarIpc(languageGrammarInstaller)
  registerWorkbenchFsIpc(new WorkbenchProjectFileSystem(), parts)
  registerWorkbenchTerminalIpc(parts.terminal)
  registerWorkbenchGitIpc(new WorkbenchGitService())
  const disposeWatchIpc = registerWorkbenchWatchIpc(new WorkbenchFileWatcher())

  const languageServiceClient = new WorkbenchLanguageServiceWorkerClient()
  registerWorkbenchLanguageServiceIpc(languageServiceClient)
  installLanguageServiceProjectLifecycle(hub, languageServiceClient)
  let shutdownStarted = false
  app.on('before-quit', (event) => {
    if (shutdownStarted) return

    shutdownStarted = true
    event.preventDefault()
    // Electron 不等待 async listener：第一次 before-quit 必须拦住退出，待子进程与 worker
    // 真正收口后再触发第二次 quit；shutdownStarted 让第二次事件直接放行。
    disposeWatchIpc()
    disposeLanguageGrammarIpc()
    void Promise.all([parts.terminal.closeAllSessions(), languageServiceClient.dispose()]).finally(
      () => app.quit()
    )
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
