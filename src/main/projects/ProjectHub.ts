/**
 * 独立 Workbench 应用的项目枢纽（main 侧服务）：当前项目状态 + 最近项目 + 目录校验 / 创建。
 *
 * renderer 起手页只投影本服务广播的 `WorkbenchProjectHubState`；窗口标题与应用菜单同样订阅
 * 本服务。目录选择走系统对话框，校验与持久化全部留在 main——renderer 不接触文件系统。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { type BrowserWindow, dialog } from 'electron'

import type {
  WorkbenchOpenedProject,
  WorkbenchPickLocationResult,
  WorkbenchProjectCreateResult,
  WorkbenchProjectHubState,
  WorkbenchProjectOpenFailureReason,
  WorkbenchProjectOpenResult,
} from '../../shared/projectHub'

import { RecentProjectsStore } from './RecentProjectsStore'

type ProjectHubListener = (state: WorkbenchProjectHubState) => void

/** 项目名校验：拒绝路径分隔符与跨平台保留字符，长度 1–80，不以点开头。 */
const InvalidProjectNamePattern = /[\\/:*?"<>|]/
const MaxProjectNameLength = 80

export class WorkbenchProjectHub {
  private readonly store: RecentProjectsStore
  private readonly listeners = new Set<ProjectHubListener>()
  private currentProject: Nullable<WorkbenchOpenedProject> = null

  constructor(dataRootDir: string) {
    this.store = new RecentProjectsStore(dataRootDir)
  }

  public getState(): WorkbenchProjectHubState {
    return {
      currentProject: this.currentProject,
      recentProjects: this.store.list().map((entry) => ({
        ...entry,
        missing: validateProjectDirectory(entry.path) !== null,
      })),
    }
  }

  public onStateChanged(listener: ProjectHubListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 打开一个已存在的项目目录；失败也广播一次状态，让起手页的 missing 灰显跟上现实。 */
  public openProjectPath(path: string): WorkbenchProjectOpenResult {
    const projectPath = resolve(path)
    const failure = validateProjectDirectory(projectPath)
    if (failure) {
      this.emitState()
      return { ok: false, reason: failure }
    }

    const project: WorkbenchOpenedProject = { path: projectPath, name: basename(projectPath) }
    this.store.touch({ path: project.path, name: project.name, lastOpenedAt: Date.now() })
    this.currentProject = project
    this.emitState()
    return { ok: true, project }
  }

  public async openProjectViaDialog(
    parent: Nullable<BrowserWindow>
  ): Promise<WorkbenchProjectOpenResult> {
    const picked = await pickDirectory(parent, '打开项目')
    if (!picked) return { ok: false, reason: 'canceled' }

    return this.openProjectPath(picked)
  }

  public async pickNewProjectLocation(
    parent: Nullable<BrowserWindow>
  ): Promise<WorkbenchPickLocationResult> {
    const picked = await pickDirectory(parent, '选择项目位置')
    if (!picked) return { ok: false, reason: 'canceled' }

    return { ok: true, path: picked }
  }

  /** 新建项目（最小形态）：位置 + 名称 → 创建空目录并直接打开。 */
  public createProject(locationPath: string, name: string): WorkbenchProjectCreateResult {
    const projectName = name.trim()
    if (
      projectName.length === 0 ||
      projectName.length > MaxProjectNameLength ||
      projectName.startsWith('.') ||
      InvalidProjectNamePattern.test(projectName)
    ) return { ok: false, reason: 'invalid-name' }

    const location = resolve(locationPath)
    if (validateProjectDirectory(location) !== null) return { ok: false, reason: 'location-missing' }

    const projectPath = join(location, projectName)
    if (existsSync(projectPath)) return { ok: false, reason: 'already-exists' }

    try {
      mkdirSync(projectPath)
    } catch (error) {
      console.error('[workbench-app] failed to create project directory', error)
      return { ok: false, reason: 'io-error' }
    }

    const opened = this.openProjectPath(projectPath)
    if (!opened.ok) return { ok: false, reason: 'io-error' }

    return { ok: true, project: opened.project }
  }

  public removeRecentProject(path: string): WorkbenchProjectHubState {
    this.store.remove(resolve(path))
    this.emitState()
    return this.getState()
  }

  public closeProject(): WorkbenchProjectHubState {
    this.currentProject = null
    this.emitState()
    return this.getState()
  }

  private emitState(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

function validateProjectDirectory(path: string): Nullable<WorkbenchProjectOpenFailureReason> {
  try {
    return statSync(path).isDirectory() ? null : 'not-a-directory'
  } catch {
    return 'missing'
  }
}

async function pickDirectory(
  parent: Nullable<BrowserWindow>,
  title: string
): Promise<Nullable<string>> {
  const options = {
    title,
    properties: ['openDirectory', 'createDirectory'],
  } satisfies Electron.OpenDialogOptions

  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  const picked = result.filePaths[0]
  return result.canceled || !picked ? null : picked
}
