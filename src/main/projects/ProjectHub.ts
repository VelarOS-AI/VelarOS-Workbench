/**
 * 独立 Workbench 应用的项目枢纽（main 侧服务）：当前项目状态 + 最近项目 + 目录校验 / 创建。
 *
 * renderer 起手页只投影本服务广播的 `WorkbenchProjectHubState`；窗口标题与应用菜单同样订阅
 * 本服务。目录选择走系统对话框，校验与持久化全部留在 main——renderer 不接触文件系统。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type {
  WorkbenchOpenedProject,
  WorkbenchProjectCreateResult,
  WorkbenchProjectHubState,
  WorkbenchProjectOpenFailureReason,
  WorkbenchProjectOpenResult,
} from '../../shared/projectHub'

import type { RecentProjectsStore } from './RecentProjectsStore'

type ProjectHubListener = (state: WorkbenchProjectHubState) => void

/** 项目名校验：拒绝路径分隔符与跨平台保留字符，长度 1–80，不以点开头。 */
const InvalidProjectNamePattern = /[\\/:*?"<>|]/
const MaxProjectNameLength = 80

export class WorkbenchProjectHub {
  private readonly listeners = new Set<ProjectHubListener>()
  private currentProject: Nullable<WorkbenchOpenedProject> = null

  constructor(private readonly store: RecentProjectsStore) {}

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

  /** 新建项目（最小形态）：位置 + 名称 → 创建空目录；由窗口管理器决定在哪个窗口打开。 */
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

    return {
      ok: true,
      project: {
        path: projectPath,
        name: projectName,
      },
    }
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

  /** 共享最近项目变化后刷新当前窗口投影，不改变它的活跃项目。 */
  public refreshState(): void {
    this.emitState()
  }

  private emitState(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

export function validateProjectDirectory(path: string): Nullable<WorkbenchProjectOpenFailureReason> {
  try {
    return statSync(path).isDirectory() ? null : 'not-a-directory'
  } catch {
    return 'missing'
  }
}
