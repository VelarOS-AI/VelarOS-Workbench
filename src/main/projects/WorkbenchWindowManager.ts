import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { type BaseWindow, BrowserWindow, type WebContents } from 'electron'
import { execa } from 'execa'

import {
  type WorkbenchOpenedProject,
  type WorkbenchProjectCloneResult,
  type WorkbenchProjectCreateResult,
  type WorkbenchProjectDropResult,
  WorkbenchProjectHubChannels,
  type WorkbenchProjectHubMenuCommand,
  type WorkbenchProjectHubState,
  type WorkbenchProjectOpenResult,
} from '../../shared/projectHub'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

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

  /** 打开着这个项目的窗口的 WebContents：项目路径全局去重，最多一个。 */
  public getWebContentsForProject(projectRoot: string): Nullable<WebContents> {
    const target = resolve(projectRoot)
    for (const record of this.records.values()) {
      const path = record.hub.getState().currentProject?.path
      if (path && resolve(path) === target && !record.window.isDestroyed())
        return record.window.webContents
    }
    return null
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
    const picked = await pickDirectory(targetWindow, workbenchMainText('projects.pickOpen'))
    if (!picked) return { ok: false, reason: 'canceled' }

    return this.openProjectPath(targetWindow?.webContents ?? null, picked)
  }

  public async switchProjectViaDialog(
    sender: WebContents
  ): Promise<WorkbenchProjectOpenResult> {
    const picked = await pickDirectory(
      this.getWindowForWebContents(sender),
      workbenchMainText('projects.pickSwitch')
    )
    if (!picked) return { ok: false, reason: 'canceled' }

    return this.switchProjectPath(sender, picked)
  }

  public async openProjectInNewWindowViaDialog(
    targetWindow: Nullable<BrowserWindow>
  ): Promise<WorkbenchProjectOpenResult> {
    const picked = await pickDirectory(targetWindow, workbenchMainText('projects.pickOpenInNewWindow'))
    if (!picked) return { ok: false, reason: 'canceled' }

    return this.openProjectPathInNewWindow(picked)
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

  /** 在原窗口重绑项目；释放旧项目资源后才广播新根。 */
  public async switchProjectPath(
    sender: WebContents,
    path: string
  ): Promise<WorkbenchProjectOpenResult> {
    const projectPath = resolve(path)
    const failure = validateProjectDirectory(projectPath)
    const target = this.getRecord(sender)
    if (failure || !target) {
      target?.hub.refreshState()
      return { ok: false, reason: failure ?? 'missing' }
    }

    const currentProjectPath = target.hub.getState().currentProject?.path
    if (currentProjectPath === projectPath) {
      this.focusWindow(target.window)
      return target.hub.openProjectPath(projectPath)
    }

    const existing = this.findProjectRecord(projectPath)
    if (existing) {
      this.focusWindow(existing.window)
      return existing.hub.openProjectPath(projectPath)
    }

    if (currentProjectPath) {
      await this.releaseProjectResources(sender.id, currentProjectPath)
    }
    const opened = target.hub.openProjectPath(projectPath)
    if (opened.ok) {
      this.focusWindow(target.window)
      this.refreshRecentProjectsExcept(target.hub)
    }
    return opened
  }

  public openProjectPathInNewWindow(path: string): WorkbenchProjectOpenResult {
    return this.openProjectPath(null, path)
  }

  public async cloneProjectInNewWindow(
    sender: WebContents,
    remoteUrl: string
  ): Promise<WorkbenchProjectCloneResult> {
    const normalizedRemote = normalizeGitRemote(remoteUrl)
    if (!normalizedRemote) return { ok: false, reason: 'invalid-remote' }

    const parent = await pickDirectory(
      this.getWindowForWebContents(sender),
      workbenchMainText('projects.pickCloneLocation')
    )
    if (!parent) return { ok: false, reason: 'canceled' }

    const projectPath = join(parent, normalizedRemote.projectName)
    if (existsSync(projectPath)) return { ok: false, reason: 'already-exists' }

    const result = await execa(
      'git',
      ['clone', '--', normalizedRemote.remoteUrl, projectPath],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
        reject: false,
        timeout: 120_000,
      }
    )
    if (result.failed) {
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
      console.error('[workbench-app] failed to clone project', {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      })
      return { ok: false, reason: 'clone-failed' }
    }

    const opened = this.openProjectPathInNewWindow(projectPath)
    return opened.ok
      ? { ok: true, project: opened.project }
      : { ok: false, reason: 'clone-failed' }
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
    return this.returnToEntry(sender)
  }

  /** 退出项目或账户都只释放当前项目并返回起手页；只有用户关闭最后一个窗口才退出应用。 */
  public async returnToEntry(sender: WebContents): Promise<WorkbenchProjectHubState> {
    const record = this.getRecord(sender)
    if (!record) return emptyProjectHubState()

    const projectRoot = record.hub.getState().currentProject?.path
    const state = record.hub.closeProject()
    if (projectRoot) {
      await this.releaseProjectResources(sender.id, projectRoot)
    }
    return state
  }

  public async openDroppedPaths(
    sender: WebContents,
    paths: readonly string[]
  ): Promise<WorkbenchProjectDropResult> {
    return this.openResolvedExternalPaths(sender, paths)
  }

  public async openExternalPaths(
    paths: readonly string[],
    targetWindow: Nullable<BrowserWindow> = this.getFocusedWindow()
  ): Promise<WorkbenchProjectDropResult> {
    return this.openResolvedExternalPaths(targetWindow?.webContents ?? null, paths)
  }

  public acknowledgeFileOpen(sender: WebContents, id: number): WorkbenchProjectHubState {
    return this.getHubForWebContents(sender)?.acknowledgeFileOpen(id) ?? emptyProjectHubState()
  }

  private async openResolvedExternalPaths(
    sender: Nullable<WebContents>,
    paths: readonly string[]
  ): Promise<WorkbenchProjectDropResult> {
    const opened: WorkbenchOpenedProject[] = []
    const openedFiles: WorkbenchProjectDropResult['openedFiles'] = []
    const rejected: WorkbenchProjectDropResult['rejected'] = []
    const seen = new Set<string>()
    const openedProjectPaths = new Set<string>()

    for (const path of paths) {
      const externalPath = resolve(path)
      if (seen.has(externalPath)) continue
      seen.add(externalPath)

      let isDirectory = false
      let isFile = false
      try {
        const stat = statSync(externalPath)
        isDirectory = stat.isDirectory()
        isFile = stat.isFile()
      } catch {
        rejected.push({ path: externalPath, reason: 'missing' })
        continue
      }

      if (!isDirectory && !isFile) {
        rejected.push({ path: externalPath, reason: 'not-a-directory' })
        continue
      }

      const existingFileProject = isFile ? this.findContainingProjectRecord(externalPath) : null
      const projectPath = isDirectory
        ? externalPath
        : (existingFileProject?.hub.getState().currentProject?.path ??
          findNearestProjectRoot(externalPath))

      const result = this.openProjectPath(sender, projectPath)
      if (result.ok) {
        if (!openedProjectPaths.has(result.project.path)) {
          openedProjectPaths.add(result.project.path)
          opened.push(result.project)
        }
        if (isFile) {
          const record = this.findProjectRecord(result.project.path)
          const filePath = toProjectRelativePath(result.project.path, externalPath)
          if (record && filePath) {
            record.hub.requestFileOpen(filePath)
            openedFiles.push({ projectPath: result.project.path, path: filePath })
          } else {
            rejected.push({ path: externalPath, reason: 'missing' })
          }
        }
      } else {
        rejected.push({ path: externalPath, reason: result.reason })
      }
    }

    return { opened, openedFiles, rejected }
  }

  /** 只发给触发菜单的那个项目窗口；不是项目窗口（或已经关了）就什么也不做，不会新开窗口。 */
  public sendMenuCommandToWindow(
    target: Nullable<BaseWindow>,
    command: WorkbenchProjectHubMenuCommand
  ): void {
    const record = [...this.records.values()].find((candidate) => candidate.window === target)
    if (!record || record.window.isDestroyed()) return

    record.window.webContents.send(WorkbenchProjectHubChannels.menuCommand, command)
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

  private findContainingProjectRecord(filePath: string): Nullable<WorkbenchWindowRecord> {
    const candidates = [...this.records.values()].filter((record) => {
      const projectPath = record.hub.getState().currentProject?.path
      return projectPath ? isPathInside(projectPath, filePath) : false
    })
    candidates.sort((left, right) => {
      const leftPath = left.hub.getState().currentProject?.path ?? ''
      const rightPath = right.hub.getState().currentProject?.path ?? ''
      return rightPath.length - leftPath.length
    })
    return candidates[0] ?? null
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

const GitRemoteMaxLength = 2_048
const GitRemoteProtocols = new Set(['git:', 'http:', 'https:', 'ssh:'])
const ScpLikeGitRemotePattern = /^[\w.-]+@[\w.-]+:[^\s]+$/u
const InvalidClonedProjectNamePattern = /[\\/:*?"<>|]/u

function normalizeGitRemote(
  remoteUrl: string
): Nullable<{ projectName: string; remoteUrl: string }> {
  const normalized = remoteUrl.trim()
  if (!normalized || normalized.length > GitRemoteMaxLength || /\s/u.test(normalized)) return null

  let pathPart = normalized
  if (!ScpLikeGitRemotePattern.test(normalized)) {
    try {
      const parsed = new URL(normalized)
      if (!GitRemoteProtocols.has(parsed.protocol) || !parsed.hostname) return null
      pathPart = parsed.pathname
    } catch {
      return null
    }
  } else {
    pathPart = normalized.slice(normalized.indexOf(':') + 1)
  }

  const rawName = pathPart.replace(/\/+$/u, '').split('/').at(-1) ?? ''
  const projectName = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName
  if (
    !projectName ||
    projectName.length > 80 ||
    projectName.startsWith('.') ||
    InvalidClonedProjectNamePattern.test(projectName)
  ) return null

  return { projectName, remoteUrl: normalized }
}

function emptyProjectHubState(): WorkbenchProjectHubState {
  return { currentProject: null, recentProjects: [], pendingFileOpen: null }
}

const WorkbenchProjectRootMarkers = [
  '.git',
  '.hg',
  '.svn',
  '.idea',
  'package.json',
  'velar.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
] as const

function findNearestProjectRoot(filePath: string): string {
  let candidate = dirname(filePath)
  while (true) {
    if (WorkbenchProjectRootMarkers.some((marker) => existsSync(join(candidate, marker)))) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return dirname(filePath)
    candidate = parent
  }
}

function isPathInside(projectPath: string, candidatePath: string): boolean {
  const projectRelativePath = relative(projectPath, candidatePath)
  return (
    projectRelativePath.length > 0 &&
    projectRelativePath !== '..' &&
    !projectRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(projectRelativePath)
  )
}

function toProjectRelativePath(projectPath: string, filePath: string): Nullable<string> {
  if (!isPathInside(projectPath, filePath)) return null
  return relative(projectPath, filePath).split(sep).join('/')
}
