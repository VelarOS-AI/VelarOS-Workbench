/**
 * 独立 Workbench 应用「项目枢纽」的 main ↔ renderer IPC 契约（应用私有）。
 *
 * 起手页（欢迎页）与应用菜单共用这一面：最近项目持久化、目录校验与项目创建都在 main 侧
 * 服务完成，renderer 只投影 `WorkbenchProjectHubState` 并发起动作。本契约刻意不进
 * Platform 核心——项目、窗口和产品导航始终由 Workbench 持有。
 */
import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'

export const WorkbenchProjectHubChannels = {
  getState: 'workbench-app:project-hub:get-state',
  resolveRegistration: 'workbench-app:project-hub:resolve-registration',
  openProjectDialog: 'workbench-app:project-hub:open-project-dialog',
  openProjectPath: 'workbench-app:project-hub:open-project-path',
  switchProjectPath: 'workbench-app:project-hub:switch-project-path',
  openProjectDialogInNewWindow: 'workbench-app:project-hub:open-project-dialog-in-new-window',
  openProjectPathInNewWindow: 'workbench-app:project-hub:open-project-path-in-new-window',
  cloneProjectInNewWindow: 'workbench-app:project-hub:clone-project-in-new-window',
  openDroppedPaths: 'workbench-app:project-hub:open-dropped-paths',
  acknowledgeFileOpen: 'workbench-app:project-hub:acknowledge-file-open',
  openSystemPath: 'workbench-app:project-hub:open-system-path',
  revealSystemPath: 'workbench-app:project-hub:reveal-system-path',
  pickNewProjectLocation: 'workbench-app:project-hub:pick-new-project-location',
  createProject: 'workbench-app:project-hub:create-project',
  removeRecentProject: 'workbench-app:project-hub:remove-recent-project',
  returnToEntry: 'workbench-app:project-hub:return-to-entry',
  stateChanged: 'workbench-app:project-hub:state-changed',
  menuCommand: 'workbench-app:project-hub:menu-command',
  setLocale: 'workbench-app:project-hub:set-locale',
} as const

/** IDE 状态的持久身份；由主进程登记，窗口只请求当前项目。 */
export interface WorkbenchProject {
  id: string
  name: string
  rootPath: string
  createdAt: number
  lastOpenedAt: Nullable<number>
  pinned: boolean
}

export interface WorkbenchOpenedProject {
  /** 项目根目录绝对路径。 */
  path: string
  /** 展示名（目录名）。 */
  name: string
}

export interface WorkbenchRecentProject {
  path: string
  name: string
  /** 最近一次打开的 Unix 毫秒时间戳。 */
  lastOpenedAt: number
  /** 路径当前不存在（或不是目录）：起手页灰显，仅可移除。 */
  missing: boolean
}

export interface WorkbenchProjectHubState {
  currentProject: Nullable<WorkbenchOpenedProject>
  recentProjects: WorkbenchRecentProject[]
  pendingFileOpen: Nullable<WorkbenchPendingFileOpen>
}

export interface WorkbenchPendingFileOpen {
  id: number
  /** 相对项目根的文件路径；renderer 直接交给编辑器文件端口。 */
  path: string
}

export type WorkbenchProjectOpenFailureReason = 'canceled' | 'missing' | 'not-a-directory'

export type WorkbenchProjectOpenResult =
  | { ok: true; project: WorkbenchOpenedProject }
  | { ok: false; reason: WorkbenchProjectOpenFailureReason }

export interface WorkbenchProjectDropResult {
  opened: WorkbenchOpenedProject[]
  openedFiles: Array<{
    projectPath: string
    path: string
  }>
  rejected: Array<{
    path: string
    reason: WorkbenchProjectOpenFailureReason
  }>
}

export type WorkbenchProjectCreateFailureReason =
  'invalid-name' | 'location-missing' | 'already-exists' | 'io-error'

export type WorkbenchProjectCreateResult =
  | { ok: true; project: WorkbenchOpenedProject }
  | { ok: false; reason: WorkbenchProjectCreateFailureReason }

export type WorkbenchProjectCloneFailureReason =
  'canceled' | 'invalid-remote' | 'already-exists' | 'clone-failed'

export type WorkbenchProjectCloneResult =
  | { ok: true; project: WorkbenchOpenedProject }
  | { ok: false; reason: WorkbenchProjectCloneFailureReason }

export type WorkbenchPickLocationResult =
  { ok: true; path: string } | { ok: false; reason: 'canceled' }

export type WorkbenchProjectHubMenuCommand =
  /** ⌘W / Ctrl+W：关掉编辑区当前的标签；没有标签时什么也不做。 */
  | 'close-editor'
  | 'close-project'
  | 'new-project'
  | 'zoom-editor-in'
  | 'zoom-editor-out'
  | 'zoom-editor-reset'

/** preload 通过 contextBridge 暴露给 renderer 的项目枢纽桥面。 */
export interface WorkbenchProjectHubBridge {
  /** 首次把现有本地项目身份转交给主进程；后续只返回当前窗口的登记记录。 */
  resolveRegistration: (legacyProjects: readonly WorkbenchProject[]) => Promise<WorkbenchProject>
  getState: () => Promise<WorkbenchProjectHubState>
  openProjectDialog: () => Promise<WorkbenchProjectOpenResult>
  openProjectPath: (path: string) => Promise<WorkbenchProjectOpenResult>
  switchProjectPath: (path: string) => Promise<WorkbenchProjectOpenResult>
  openProjectDialogInNewWindow: () => Promise<WorkbenchProjectOpenResult>
  openProjectPathInNewWindow: (path: string) => Promise<WorkbenchProjectOpenResult>
  cloneProjectInNewWindow: (remoteUrl: string) => Promise<WorkbenchProjectCloneResult>
  openDroppedPaths: (paths: string[]) => Promise<WorkbenchProjectDropResult>
  acknowledgeFileOpen: (id: number) => Promise<WorkbenchProjectHubState>
  /** Electron 41 不再暴露 File.path；preload 用 webUtils 恢复可信的原生拖拽路径。 */
  getPathForFile: (file: File) => string
  openSystemPath: (path: string) => Promise<{ opened: boolean; error?: string }>
  /** 在访达（资源管理器）中显示这个文件或目录。 */
  revealSystemPath: (path: string) => Promise<{ opened: boolean; error?: string }>
  pickNewProjectLocation: () => Promise<WorkbenchPickLocationResult>
  createProject: (locationPath: string, name: string) => Promise<WorkbenchProjectCreateResult>
  removeRecentProject: (path: string) => Promise<WorkbenchProjectHubState>
  /** 清理当前项目并回到起手页，不退出应用。 */
  returnToEntry: () => Promise<WorkbenchProjectHubState>
  onStateChanged: (listener: (state: WorkbenchProjectHubState) => void) => () => void
  onMenuCommand: (listener: (command: WorkbenchProjectHubMenuCommand) => void) => () => void
  /** 界面语言：窗口打开和用户切换语言时报给 main，应用菜单等 main 侧文字跟着换。 */
  setLocale: (locale: AppLocale) => void
}
