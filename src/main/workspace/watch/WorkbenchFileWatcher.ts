import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { SystemWorkspaceFilesChangedEvent } from '@shared/contracts'

import { isWorkbenchSaveTemporaryName } from '../AtomicFileWrite'
import { shouldSkipProjectDirectory } from '../WorkbenchSkippedDirectories'

const WorkbenchWatchDebounceMs = 120

interface RootWatch {
  watcher: FSWatcher
  subscriptions: Set<string>
  /** 原始事件的观察者（改动归属账本）：事件一到就交出，不合并、不过滤生成目录。 */
  rawObservers: Set<WorkbenchRawPathObserver>
  paths: Set<string>
  timer: Nullable<ReturnType<typeof setTimeout>>
}

interface Subscription {
  rootPath: string
  listener: (event: SystemWorkspaceFilesChangedEvent) => void
}

interface WorkbenchFileWatcherDependencies {
  debounceMs?: number
  now?: () => number
  onFilesChanged?: (event: SystemWorkspaceFilesChangedEvent) => void
}

/** 一个根目录上的原始文件事件：路径相对根目录、`/` 分隔。 */
export interface WorkbenchRawPathObserver {
  /**
   * 某个路径有了动静；监听回调里同步调用。到达可能比改动晚好几秒（macOS 忙时成批送达），改动发生的时刻
   * 要看路径自己的时间戳。
   */
  onPath(path: string): void
  /** 监听出错或报了一个没有路径的事件：从这里起可能漏掉了事件。 */
  onError(): void
}

/** 原始事件的来源（改动归属账本只依赖这一面）。 */
export interface WorkbenchRawPathSource {
  observeRawPaths(
    workspaceRoot: string,
    observer: WorkbenchRawPathObserver
  ): Promise<{ workspaceRoot: string; stop: () => void }>
}

/** 相对根目录的规范路径；根目录本身与根目录之外的为 null。 */
function toRootRelativePath(rootPath: string, filename: string): Nullable<string> {
  const path = relative(rootPath, resolve(rootPath, filename)).replace(/\\/g, '/')
  if (!path || path === '.' || path.startsWith('../') || path === '..') return null
  return path
}

function normalizeRelativePath(rootPath: string, filename: string): Nullable<string> {
  const path = toRootRelativePath(rootPath, filename)
  if (!path) return null

  const segments = path.split('/').filter(Boolean)
  const isGitState =
    segments[0] === '.git' &&
    (segments[1] === 'HEAD' ||
      segments[1] === 'index' ||
      segments[1] === 'packed-refs' ||
      segments[1] === 'refs')
  if (isGitState) return path
  if (segments.some((segment) => shouldSkipProjectDirectory(segment))) return null
  // 编辑器保存时写在目标旁边、随即 rename 盖过去的临时文件：真正的改动是目标本身的事件。
  if (isWorkbenchSaveTemporaryName(segments.at(-1) ?? '')) return null

  return path
}

/**
 * 独立 Workbench 的项目文件监听器。
 *
 * 同一真实根目录只持有一个递归 fs.watch；renderer 订阅以 UUID 隔离，根事件在 120ms
 * 窗口内合并后逐订阅投递。服务不依赖 Desktop session，也不写 Agent signals。
 *
 * 改动归属账本另走原始事件（{@link observeRawPaths}）：它要每个路径各自的动静，一到就去读那个路径的
 * 改动时刻；生成目录（build、dist……）里的文件也可能是 Agent 命令的产物，不能先滤掉。
 */
export class WorkbenchFileWatcher implements WorkbenchRawPathSource {
  private readonly roots = new Map<string, RootWatch>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly onFilesChanged: (event: SystemWorkspaceFilesChangedEvent) => void

  constructor(dependencies: WorkbenchFileWatcherDependencies = {}) {
    this.debounceMs = dependencies.debounceMs ?? WorkbenchWatchDebounceMs
    this.now = dependencies.now ?? Date.now
    this.onFilesChanged = dependencies.onFilesChanged ?? (() => undefined)
  }

  public async subscribe(
    workspaceRoot: string,
    listener: (event: SystemWorkspaceFilesChangedEvent) => void
  ): Promise<{ subscriptionId: string; workspaceRoot: string }> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const subscriptionId = randomUUID()

    this.ensureRootWatch(rootPath).subscriptions.add(subscriptionId)
    this.subscriptions.set(subscriptionId, { rootPath, listener })
    return { subscriptionId, workspaceRoot: rootPath }
  }

  public unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return

    this.subscriptions.delete(subscriptionId)
    this.roots.get(subscription.rootPath)?.subscriptions.delete(subscriptionId)
    this.releaseRootWatchIfIdle(subscription.rootPath)
  }

  /** 听一个根目录的原始事件，直到调用返回的 `stop`；与 renderer 订阅共用同一个递归监听。 */
  public async observeRawPaths(
    workspaceRoot: string,
    observer: WorkbenchRawPathObserver
  ): Promise<{ workspaceRoot: string; stop: () => void }> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    this.ensureRootWatch(rootPath).rawObservers.add(observer)
    let stopped = false
    return {
      workspaceRoot: rootPath,
      stop: () => {
        if (stopped) return
        stopped = true
        this.roots.get(rootPath)?.rawObservers.delete(observer)
        this.releaseRootWatchIfIdle(rootPath)
      },
    }
  }

  public dispose(): void {
    for (const rootWatch of this.roots.values()) {
      if (rootWatch.timer) clearTimeout(rootWatch.timer)
      rootWatch.watcher.close()
    }
    this.roots.clear()
    this.subscriptions.clear()
  }

  private ensureRootWatch(rootPath: string): RootWatch {
    const existing = this.roots.get(rootPath)
    if (existing) return existing

    const watcher = watch(rootPath, { persistent: true, recursive: true }, (_event, filename) => {
      this.receive(rootPath, filename?.toString() ?? null)
    })
    const rootWatch: RootWatch = {
      watcher,
      subscriptions: new Set(),
      rawObservers: new Set(),
      paths: new Set(),
      timer: null,
    }
    watcher.on('error', () => {
      // 单次监听错误不伪造文件事件；订阅仍保留，让平台 watcher 自己恢复或由项目切换释放。
      // 原始事件的观察者要知道：从这里起的事件可能漏了。
      for (const observer of [...rootWatch.rawObservers]) observer.onError()
    })
    this.roots.set(rootPath, rootWatch)
    return rootWatch
  }

  private releaseRootWatchIfIdle(rootPath: string): void {
    const rootWatch = this.roots.get(rootPath)
    if (!rootWatch || rootWatch.subscriptions.size > 0 || rootWatch.rawObservers.size > 0) return

    if (rootWatch.timer) clearTimeout(rootWatch.timer)
    rootWatch.watcher.close()
    this.roots.delete(rootPath)
  }

  private async resolveRoot(input: string): Promise<string> {
    if (!input.trim()) throw new AppError('VALIDATION', '需要选择一个工程目录。')

    const candidate = resolve(input)
    const info = await stat(candidate).catch(() => null)
    if (!info?.isDirectory()) throw new AppError('VALIDATION', '需要选择一个工程目录。')

    return realpath(candidate)
  }

  private receive(rootPath: string, filename: Nullable<string>): void {
    const rootWatch = this.roots.get(rootPath)
    if (!rootWatch) return

    if (rootWatch.rawObservers.size > 0) {
      const rawPath = filename === null ? null : toRootRelativePath(rootPath, filename)
      for (const observer of [...rootWatch.rawObservers]) {
        if (filename === null) observer.onError()
        else if (rawPath) observer.onPath(rawPath)
      }
    }
    if (filename) this.queuePath(rootPath, filename)
  }

  private queuePath(rootPath: string, filename: string): void {
    const rootWatch = this.roots.get(rootPath)
    if (!rootWatch) return

    const path = normalizeRelativePath(rootPath, filename)
    if (!path) return
    rootWatch.paths.add(path)

    if (rootWatch.timer) clearTimeout(rootWatch.timer)
    rootWatch.timer = setTimeout(() => this.flush(rootPath), this.debounceMs)
  }

  private flush(rootPath: string): void {
    const rootWatch = this.roots.get(rootPath)
    if (!rootWatch) return

    rootWatch.timer = null
    const paths = [...rootWatch.paths].sort()
    rootWatch.paths.clear()
    if (paths.length === 0) return

    const event: SystemWorkspaceFilesChangedEvent = {
      kind: 'velaros.systemWorkspaceFilesChanged',
      source: 'filesystem-watch',
      rootPath,
      paths,
      sessionIds: [],
      changedAt: this.now(),
    }
    this.onFilesChanged(event)
    for (const subscriptionId of rootWatch.subscriptions) {
      this.subscriptions.get(subscriptionId)?.listener(event)
    }
  }
}
