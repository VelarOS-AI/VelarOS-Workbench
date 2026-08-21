/**
 * 独立 Workbench 应用「项目枢纽」的 main ↔ renderer IPC 契约（应用私有）。
 *
 * 起手页（欢迎页）与应用菜单共用这一面：最近项目持久化、目录校验与项目创建都在 main 侧
 * 服务完成，renderer 只投影 `WorkbenchProjectHubState` 并发起动作。本契约刻意不进
 * 产品核心——它是独立宿主入口形态，没有第二个消费者；
 * kernel-protocol 客户端接入后，项目打开链路若上移到 kernel 会话面，本契约随之重审。
 */

export const WorkbenchProjectHubChannels = {
  getState: 'workbench-app:project-hub:get-state',
  openProjectDialog: 'workbench-app:project-hub:open-project-dialog',
  openProjectPath: 'workbench-app:project-hub:open-project-path',
  validateProjectPath: 'workbench-app:project-hub:validate-project-path',
  openDroppedProjectPaths: 'workbench-app:project-hub:open-dropped-project-paths',
  openSystemPath: 'workbench-app:project-hub:open-system-path',
  pickNewProjectLocation: 'workbench-app:project-hub:pick-new-project-location',
  createProject: 'workbench-app:project-hub:create-project',
  removeRecentProject: 'workbench-app:project-hub:remove-recent-project',
  closeProject: 'workbench-app:project-hub:close-project',
  stateChanged: 'workbench-app:project-hub:state-changed',
  menuCommand: 'workbench-app:project-hub:menu-command',
} as const

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
}

export type WorkbenchProjectOpenFailureReason = 'canceled' | 'missing' | 'not-a-directory'

export type WorkbenchProjectOpenResult =
  | { ok: true; project: WorkbenchOpenedProject }
  | { ok: false; reason: WorkbenchProjectOpenFailureReason }

export interface WorkbenchProjectDropResult {
  opened: WorkbenchOpenedProject[]
  rejected: Array<{
    path: string
    reason: WorkbenchProjectOpenFailureReason
  }>
}

export type WorkbenchProjectCreateFailureReason =
  | 'invalid-name'
  | 'location-missing'
  | 'already-exists'
  | 'io-error'

export type WorkbenchProjectCreateResult =
  | { ok: true; project: WorkbenchOpenedProject }
  | { ok: false; reason: WorkbenchProjectCreateFailureReason }

export type WorkbenchPickLocationResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'canceled' }

export type WorkbenchProjectHubMenuCommand =
  | 'close-project'
  | 'new-project'
  | 'zoom-editor-in'
  | 'zoom-editor-out'
  | 'zoom-editor-reset'

/** preload 通过 contextBridge 暴露给 renderer 的项目枢纽桥面。 */
export interface WorkbenchProjectHubBridge {
  getState: () => Promise<WorkbenchProjectHubState>
  openProjectDialog: () => Promise<WorkbenchProjectOpenResult>
  openProjectPath: (path: string) => Promise<WorkbenchProjectOpenResult>
  validateProjectPath: (path: string) => Promise<WorkbenchProjectOpenResult>
  openDroppedProjectPaths: (paths: string[]) => Promise<WorkbenchProjectDropResult>
  /** Electron 41 不再暴露 File.path；preload 用 webUtils 恢复可信的原生拖拽路径。 */
  getPathForFile: (file: File) => string
  openSystemPath: (path: string) => Promise<{ opened: boolean; error?: string }>
  pickNewProjectLocation: () => Promise<WorkbenchPickLocationResult>
  createProject: (locationPath: string, name: string) => Promise<WorkbenchProjectCreateResult>
  removeRecentProject: (path: string) => Promise<WorkbenchProjectHubState>
  closeProject: () => Promise<WorkbenchProjectHubState>
  onStateChanged: (listener: (state: WorkbenchProjectHubState) => void) => () => void
  onMenuCommand: (listener: (command: WorkbenchProjectHubMenuCommand) => void) => () => void
}
