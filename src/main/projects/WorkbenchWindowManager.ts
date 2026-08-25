import { basename, resolve } from 'node:path'

import { BrowserWindow, type WebContents } from 'electron'

import {
  type WorkbenchOpenedProject,
  type WorkbenchProjectCreateResult,
  type WorkbenchProjectDropResult,
  WorkbenchProjectHubChannels,
  type WorkbenchProjectHubMenuCommand,
  type WorkbenchProjectHubState,
  type WorkbenchProjectOpenResult,
} from '../../shared/projectHub'

import { validateProjectDirectory, WorkbenchProjectHub } from './ProjectHub'
import { pickDirectory } from './ProjectPicker'
import { RecentProjectsStore } from './RecentProjectsStore'

interface WorkbenchWindowRecord {
  hub: WorkbenchProjectHub
  window: BrowserWindow
  unsubscribeHub: () => void
}

interface WorkbenchWindowManagerOptions {
  createBrowserWindow: (hub: WorkbenchProjectHub) => BrowserWindow
  releaseProjectResources?: (ownerId: number, projectRoot: string) => Promise<void>
  onLastProjectClosed?: () => void
}

type WorkbenchWindowManagerListener = () => void

/**
 * 独立 Workbench 的多窗口项目所有权：一个 BrowserWindow 只拥有一个项目，多个项目通过
 * 多个窗口并行。项目路径全局去重；再次打开已存在的根时只聚焦原窗口，不创建第二份
 * Git / LSP / terminal / Agent 上下文。
 */
export class WorkbenchWindowManager {
  private readonly store: RecentProjectsStore
  private readonly records = new Map<number, WorkbenchWindowRecord>()
  private readonly listeners = new Set<WorkbenchWindowManagerListener>()

  constructor(
    dataRootDir: string,
    private readonly options: WorkbenchWindowManagerOptions
  ) {
    this.store = new RecentProjectsStore(dataRootDir)
  }

  public createWindow(initialProjectPath?: string): BrowserWindow {
    const hub = new WorkbenchProjectHub(this.store)
    if (initialProjectPath) {
      const opened = hub.openProjectPath(initialProjectPath)
      if (!opened.ok) {
        throw new Error(`Cannot create Workbench window for project: ${initialProjectPath}`)
      }
    }

    const window = this.options.createBrowserWindow(hub)
    const ownerId = window.webContents.id
    const unsubscribeHub = hub.onStateChanged((state) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(WorkbenchProjectHubChannels.stateChanged, state)
      }
      this.emitChanged()
    })
    this.records.set(ownerId, { hub, window, unsubscribeHub })

    window.once('closed', () => {
      const record = this.records.get(ownerId)
      if (!record) return

      this.records.delete(ownerId)
      record.unsubscribeHub()
      const projectRoot = record.hub.getState().currentProject?.path
      if (projectRoot) {
        void this.releaseProjectResources(ownerId, projectRoot)
        this.quitAfterLastProjectClosed()
      }
      this.emitChanged()
    })
    window.on('focus', () => this.emitChanged())

    this.refreshRecentProjectsExcept(hub)
    this.emitChanged()
    return window
  }

  public getHubForWebContents(sender: WebContents): Nullable<WorkbenchProjectHub> {
    return this.records.get(sender.id)?.hub ?? null
  }

  public getWindowForWebContents(sender: WebContents): Nullable<BrowserWindow> {
    return this.records.get(sender.id)?.window ?? null
  }

  public getFocusedWindow(): Nullable<BrowserWindow> {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && this.records.has(focused.webContents.id)) return focused

    return this.records.values().next().value?.window ?? null
  }

  public getFocusedState(): WorkbenchProjectHubState {
    const focused = this.getFocusedWindow()
    return focused
      ? (this.records.get(focused.webContents.id)?.hub.getState() ?? emptyProjectHubState())
      : emptyProjectHubState()
  }

  public getOpenProjectPaths(): string[] {
    return [...this.records.values()].flatMap((record) => {
      const path = record.hub.getState().currentProject?.path
      return path ? [path] : []
    })
  }

  public activateOrCreateWindow(): BrowserWindow {
    const window = this.getFocusedWindow() ?? this.createWindow()
    this.focusWindow(window)
    return window
  }

  public onChanged(listener: WorkbenchWindowManagerListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public async openProjectViaDialog(
    targetWindow: Nullable<BrowserWindow>
  ): Promise<WorkbenchProjectOpenResult> {
    const picked = await pickDirectory(targetWindow, '打开项目')
    if (!picked) return { ok: false, reason: 'canceled' }

    return this.openProjectPath(targetWindow?.webContents ?? null, picked)
  }

  public openProjectPath(
    sender: Nullable<WebContents>,
    path: string
  ): WorkbenchProjectOpenResult {
    const projectPath = resolve(path)
    const failure = validateProjectDirectory(projectPath)
    if (failure) {
      this.getHub(sender)?.refreshState()
      return { ok: false, reason: failure }
    }

    const existing = this.findProjectRecord(projectPath)
    if (existing) {
      const opened = existing.hub.openProjectPath(projectPath)
      this.focusWindow(existing.window)
      this.refreshRecentProjectsExcept(existing.hub)
      return opened
    }

    const target = this.getRecord(sender)
    if (!target || target.hub.getState().currentProject) {
      const window = this.createWindow(projectPath)
      this.focusWindow(window)
      const project = this.records.get(window.webContents.id)?.hub.getState().currentProject
      return project ? { ok: true, project } : { ok: false, reason: 'missing' }
    }

    const opened = target.hub.openProjectPath(projectPath)
    if (opened.ok) {
      this.focusWindow(target.window)
      this.refreshRecentProjectsExcept(target.hub)
    }
    return opened
  }

  public validateProjectPath(path: string): WorkbenchProjectOpenResult {
    const projectPath = resolve(path)
    const failure = validateProjectDirectory(projectPath)
    return failure
      ? { ok: false, reason: failure }
      : {
          ok: true,
          project: {
            path: projectPath,
            name: basename(projectPath),
          },
        }
  }

  public createProject(
    sender: WebContents,
    locationPath: string,
    name: string
  ): WorkbenchProjectCreateResult {
    const hub = this.getHubForWebContents(sender)
    if (!hub) return { ok: false, reason: 'io-error' }

    const created = hub.createProject(locationPath, name)
    if (!created.ok) return created

    const opened = this.openProjectPath(sender, created.project.path)
    return opened.ok
      ? { ok: true, project: opened.project }
      : { ok: false, reason: 'io-error' }
  }

  public removeRecentProject(sender: WebContents, path: string): WorkbenchProjectHubState {
    const hub = this.getHubForWebContents(sender)
    if (!hub) return emptyProjectHubState()

    const state = hub.removeRecentProject(path)
    this.refreshRecentProjectsExcept(hub)
    return state
  }

  public async closeProject(sender: WebContents): Promise<WorkbenchProjectHubState> {
    const record = this.getRecord(sender)
    if (!record) return emptyProjectHubState()

    const projectRoot = record.hub.getState().currentProject?.path
    const state = record.hub.closeProject()
    if (projectRoot) {
      await this.releaseProjectResources(sender.id, projectRoot)
      this.quitAfterLastProjectClosed()
    }
    return state
  }

  public async openDroppedProjectPaths(
    sender: WebContents,
    paths: readonly string[]
  ): Promise<WorkbenchProjectDropResult> {
    return this.openProjectPaths(sender, paths)
  }

  public async openExternalProjectPaths(
    paths: readonly string[],
    targetWindow: Nullable<BrowserWindow> = this.getFocusedWindow()
  ): Promise<WorkbenchProjectDropResult> {
    return this.openProjectPaths(targetWindow?.webContents ?? null, paths)
  }

  private async openProjectPaths(
    sender: Nullable<WebContents>,
    paths: readonly string[]
  ): Promise<WorkbenchProjectDropResult> {
    const opened: WorkbenchOpenedProject[] = []
    const rejected: WorkbenchProjectDropResult['rejected'] = []
    const seen = new Set<string>()

    for (const path of paths) {
      const projectPath = resolve(path)
      if (seen.has(projectPath)) continue
      seen.add(projectPath)

      const result = this.openProjectPath(sender, projectPath)
      if (result.ok) {
        opened.push(result.project)
      } else {
        rejected.push({ path: projectPath, reason: result.reason })
      }
    }

    return { opened, rejected }
  }

  public sendMenuCommand(command: WorkbenchProjectHubMenuCommand): void {
    const window = this.getFocusedWindow() ?? this.createWindow()
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => {
        window.webContents.send(WorkbenchProjectHubChannels.menuCommand, command)
      })
      return
    }

    window.webContents.send(WorkbenchProjectHubChannels.menuCommand, command)
  }

  private getHub(sender: Nullable<WebContents>): Nullable<WorkbenchProjectHub> {
    return sender ? this.getHubForWebContents(sender) : null
  }

  private getRecord(sender: Nullable<WebContents>): Nullable<WorkbenchWindowRecord> {
    return sender ? (this.records.get(sender.id) ?? null) : null
  }

  private findProjectRecord(projectPath: string): Nullable<WorkbenchWindowRecord> {
    for (const record of this.records.values()) {
      if (record.hub.getState().currentProject?.path === projectPath) return record
    }
    return null
  }

  private focusWindow(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  }

  private refreshRecentProjectsExcept(excludedHub: WorkbenchProjectHub): void {
    for (const { hub } of this.records.values()) {
      if (hub !== excludedHub) hub.refreshState()
    }
  }

  private async releaseProjectResources(ownerId: number, projectRoot: string): Promise<void> {
    try {
      await this.options.releaseProjectResources?.(ownerId, projectRoot)
    } catch (error) {
      console.error('[workbench-app] failed to release project window resources', {
        error,
        ownerId,
        projectRoot,
      })
    }
  }

  private quitAfterLastProjectClosed(): void {
    if (this.getOpenProjectPaths().length === 0) {
      this.options.onLastProjectClosed?.()
    }
  }

  private emitChanged(): void {
    for (const listener of this.listeners) listener()
  }
}

function emptyProjectHubState(): WorkbenchProjectHubState {
  return { currentProject: null, recentProjects: [] }
}
