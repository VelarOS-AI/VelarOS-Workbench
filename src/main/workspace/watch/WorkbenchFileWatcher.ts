import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { AppError } from '@velaros-ai/velaros/core/error'

import { type SystemWorkspaceFilesChangedEvent } from '@shared/contracts/system'

import {
  type WorkbenchWatchStatus,
  WorkbenchWatchWholeRootPath,
} from '../../../shared/workbenchWatch'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import { isWorkbenchSaveTemporaryName } from '../AtomicFileWrite'
import {
  isGeneratedProjectDirectory,
  isInternalProjectDirectory,
} from '../WorkbenchSkippedDirectories'

const WorkbenchWatchDebounceMs = 120
/** 监听出错后重启的退避间隔：从 1 秒起翻倍，最长 30 秒一次，有人订阅就一直试下去。 */
const WorkbenchWatchRestartBaseDelayMs = 1_000
const WorkbenchWatchRestartMaxDelayMs = 30_000
/** 重启后稳定跑了这么久再出错，退避从头算；不到这么久又出错，接着往长里退，免得反复起停空转。 */
const WorkbenchWatchHealthyAfterMs = 60_000

type WorkbenchRecursiveWatch = (
  rootPath: string,
  onChange: (filename: Nullable<string>) => void
) => FSWatcher

interface RootWatch {
  /** 正在跑的递归监听；出错之后、重启成功之前为 null。 */
  watcher: Nullable<FSWatcher>
  subscriptions: Set<string>
  /** 原始事件的观察者（改动归属账本）：事件一到就交出，不合并、不过滤生成目录。 */
  rawObservers: Set<WorkbenchRawPathObserver>
  paths: Set<string>
  timer: Nullable<ReturnType<typeof setTimeout>>
  status: WorkbenchWatchStatus
  startedAt: number
  restartAttempt: number
  restartTimer: Nullable<ReturnType<typeof setTimeout>>
  /** 最近一次出错的原因：重启也起不来时报给订阅方。 */
  lastError: Nullable<string>
}

interface Subscription {
  rootPath: string
  listener: (event: SystemWorkspaceFilesChangedEvent) => void
  onStatus: (status: WorkbenchWatchStatus) => void
}

interface WorkbenchFileWatcherDependencies {
  debounceMs?: number
  now?: () => number
  onFilesChanged?: (event: SystemWorkspaceFilesChangedEvent) => void
  /** 建一个递归监听；测试换成会出错、起不来的假监听。 */
  watch?: WorkbenchRecursiveWatch
  restartBaseDelayMs?: number
  restartMaxDelayMs?: number
}

const watchRecursively: WorkbenchRecursiveWatch = (rootPath, onChange) =>
  watch(rootPath, { persistent: true, recursive: true }, (_event, filename) => {
    onChange(filename?.toString() ?? null)
  })

function describeWatchError(error: unknown): string {
  return AppError.getMessage(error)
}

/** 一个根目录上的原始文件事件：路径相对根目录、`/` 分隔。 */
export interface WorkbenchRawPathObserver {
  /**
   * 某个路径有了动静；监听回调里同步调用。到达可能比改动晚好几秒（macOS 忙时成批送达），改动发生的时刻
   * 要看路径自己的时间戳。
   */
  onPath(path: string): void
  /** 注册时监听不可用、运行中出错或报了一个没有路径的事件：可能漏掉了事件。 */
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

/**
 * 订阅方收到的路径。版本库的状态文件（HEAD、index、refs）照报，其余内部目录里的改动不报；依赖目录与
 * 根目录下的构建产物里的改动收成那个目录本身（`node_modules`、`packages/a/node_modules`、`dist`）——
 * 一装依赖、一跑构建就是成千上万个文件事件，不逐个灌给语言服务与界面，展开着的那个目录照样会刷新。
 * 更深处的 `build` / `dist` / `out`（常是源码）照常逐个报。
 */
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
  // 编辑器保存时写在目标旁边、随即 rename 盖过去的临时文件：真正的改动是目标本身的事件。
  if (isWorkbenchSaveTemporaryName(segments.at(-1) ?? '')) return null

  for (const [index, segment] of segments.entries()) {
    if (isInternalProjectDirectory(segment)) return null
    if (isGeneratedProjectDirectory(segment, index === 0))
      return segments.slice(0, index + 1).join('/')
  }
  return path
}

/**
 * 独立 Workbench 的项目文件监听器。
 *
 * 同一真实根目录只持有一个递归 fs.watch；renderer 订阅以 UUID 隔离，根事件在 120ms
 * 窗口内合并后逐订阅投递。服务不依赖 Desktop session，也不写 Agent signals。
 *
 * 监听不会悄悄停掉：起不来或出错之后按退避间隔重启；重启也起不来时把「不可用」报给订阅方
 * （界面上一直挂着提示），恢复后报「在监听」并补发一次整个根目录的变更——停着那阵的改动都没收到。
 * 说不清是哪个文件的事件（平台只说「这里有变化」）同样按整个根目录变更报出去，不再丢掉。
 *
 * 改动归属账本另走原始事件（{@link observeRawPaths}）：它要每个路径各自的动静，一到就去读那个路径的
 * 改动时刻；生成目录（build、dist……）里的文件也可能是 Agent 命令的产物，不能先滤掉、
 * 也不能收成目录。
 */
export class WorkbenchFileWatcher implements WorkbenchRawPathSource {
  private readonly roots = new Map<string, RootWatch>()
  private readonly subscriptions = new Map<string, Subscription>()
  private disposed = false
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly onFilesChanged: (event: SystemWorkspaceFilesChangedEvent) => void
  private readonly createWatch: WorkbenchRecursiveWatch
  private readonly restartBaseDelayMs: number
  private readonly restartMaxDelayMs: number

  constructor(dependencies: WorkbenchFileWatcherDependencies = {}) {
    this.debounceMs = dependencies.debounceMs ?? WorkbenchWatchDebounceMs
    this.now = dependencies.now ?? Date.now
    this.onFilesChanged = dependencies.onFilesChanged ?? (() => undefined)
    this.createWatch = dependencies.watch ?? watchRecursively
    this.restartBaseDelayMs = dependencies.restartBaseDelayMs ?? WorkbenchWatchRestartBaseDelayMs
    this.restartMaxDelayMs = dependencies.restartMaxDelayMs ?? WorkbenchWatchRestartMaxDelayMs
  }

  /**
   * 订阅一个根目录的合并变更。返回的 `status` 是眼下的监听状态（可能一开始就起不来）；之后的变化经
   * `onStatus` 送到。
   */
  public async subscribe(
    workspaceRoot: string,
    listener: (event: SystemWorkspaceFilesChangedEvent) => void,
    onStatus: (status: WorkbenchWatchStatus) => void = () => undefined
  ): Promise<{ subscriptionId: string; workspaceRoot: string; status: WorkbenchWatchStatus }> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const subscriptionId = randomUUID()

    const rootWatch = this.ensureRootWatch(rootPath)
    rootWatch.subscriptions.add(subscriptionId)
    this.subscriptions.set(subscriptionId, { rootPath, listener, onStatus })
    return { subscriptionId, workspaceRoot: rootPath, status: rootWatch.status }
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
    const rootWatch = this.ensureRootWatch(rootPath)
    rootWatch.rawObservers.add(observer)
    if (rootWatch.watcher === null) observer.onError()
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
    this.disposed = true
    for (const rootWatch of this.roots.values()) this.closeRootWatch(rootWatch)
    this.roots.clear()
    this.subscriptions.clear()
  }

  private ensureRootWatch(rootPath: string): RootWatch {
    if (this.disposed) throw new AppError('CLOSED', 'File watcher is closed.')
    const existing = this.roots.get(rootPath)
    if (existing) return existing

    const rootWatch: RootWatch = {
      watcher: null,
      subscriptions: new Set(),
      rawObservers: new Set(),
      paths: new Set(),
      timer: null,
      status: { state: 'watching' },
      startedAt: this.now(),
      restartAttempt: 0,
      restartTimer: null,
      lastError: null,
    }
    this.roots.set(rootPath, rootWatch)
    try {
      this.startWatcher(rootPath, rootWatch)
    } catch (error) {
      // 起不来（监听数用完、没有权限……）：先报不可用，后台按退避间隔接着试。
      rootWatch.status = { state: 'unavailable', message: describeWatchError(error) }
      this.scheduleRestart(rootPath, rootWatch)
    }
    return rootWatch
  }

  private startWatcher(rootPath: string, rootWatch: RootWatch): void {
    const watcher = this.createWatch(rootPath, (filename) => this.receive(rootPath, filename))
    rootWatch.watcher = watcher
    rootWatch.startedAt = this.now()
    watcher.on('error', (error: unknown) => {
      this.handleWatcherError(rootPath, rootWatch, watcher, error)
    })
  }

  /**
   * 监听出错：原始事件的观察者先知道从这里起可能漏了事件；关掉这个监听，按退避间隔重启——
   * 起得来就补发一次整个根目录的变更，起不来就告诉订阅方监听停了。
   */
  private handleWatcherError(
    rootPath: string,
    rootWatch: RootWatch,
    watcher: FSWatcher,
    error: unknown
  ): void {
    if (rootWatch.watcher !== watcher) return

    for (const observer of [...rootWatch.rawObservers]) observer.onError()
    rootWatch.watcher = null
    watcher.close()
    rootWatch.lastError = describeWatchError(error)
    const ranHealthy = this.now() - rootWatch.startedAt >= WorkbenchWatchHealthyAfterMs
    if (ranHealthy) rootWatch.restartAttempt = 0
    this.scheduleRestart(rootPath, rootWatch)
  }

  private scheduleRestart(rootPath: string, rootWatch: RootWatch): void {
    if (rootWatch.restartTimer || this.roots.get(rootPath) !== rootWatch) return

    const delay = Math.min(
      this.restartBaseDelayMs * 2 ** rootWatch.restartAttempt,
      this.restartMaxDelayMs
    )
    rootWatch.restartAttempt += 1
    rootWatch.restartTimer = setTimeout(() => {
      rootWatch.restartTimer = null
      this.restartWatcher(rootPath, rootWatch)
    }, delay)
  }

  private restartWatcher(rootPath: string, rootWatch: RootWatch): void {
    // 退订了（换项目、关窗口）就不再重启。
    if (this.roots.get(rootPath) !== rootWatch || rootWatch.watcher) return

    try {
      this.startWatcher(rootPath, rootWatch)
    } catch (error) {
      this.setStatus(rootWatch, {
        state: 'unavailable',
        message: describeWatchError(error) || rootWatch.lastError || undefined,
      })
      this.scheduleRestart(rootPath, rootWatch)
      return
    }

    rootWatch.lastError = null
    this.setStatus(rootWatch, { state: 'watching' })
    // 停着的那阵里的改动都没收到：整个根目录按变了报一次。
    this.queueRelativePath(rootPath, WorkbenchWatchWholeRootPath)
  }

  private setStatus(rootWatch: RootWatch, status: WorkbenchWatchStatus): void {
    const previous = rootWatch.status
    rootWatch.status = status
    if (previous.state === status.state && previous.message === status.message) return

    for (const subscriptionId of rootWatch.subscriptions) {
      this.subscriptions.get(subscriptionId)?.onStatus(status)
    }
  }

  private releaseRootWatchIfIdle(rootPath: string): void {
    const rootWatch = this.roots.get(rootPath)
    if (!rootWatch || rootWatch.subscriptions.size > 0 || rootWatch.rawObservers.size > 0) return

    this.closeRootWatch(rootWatch)
    this.roots.delete(rootPath)
  }

  private closeRootWatch(rootWatch: RootWatch): void {
    if (rootWatch.timer) clearTimeout(rootWatch.timer)
    if (rootWatch.restartTimer) clearTimeout(rootWatch.restartTimer)
    rootWatch.timer = null
    rootWatch.restartTimer = null
    rootWatch.watcher?.close()
    rootWatch.watcher = null
  }

  private async resolveRoot(input: string): Promise<string> {
    if (!input.trim()) throw new AppError('VALIDATION', workbenchMainText('paths.projectRequired'))

    const candidate = resolve(input)
    const info = await stat(candidate).catch(() => null)
    if (!info?.isDirectory())
      throw new AppError('VALIDATION', workbenchMainText('paths.projectRequired'))

    return realpath(candidate)
  }

  private receive(rootPath: string, filename: Nullable<string>): void {
    const rootWatch = this.roots.get(rootPath)
    if (!rootWatch) return

    const name = filename || null
    if (rootWatch.rawObservers.size > 0) {
      const rawPath = name === null ? null : toRootRelativePath(rootPath, name)
      for (const observer of [...rootWatch.rawObservers]) {
        if (name === null) observer.onError()
        else if (rawPath) observer.onPath(rawPath)
      }
    }
    // 说不清是哪个文件（平台只说「这里有变化」，事件太多时也会这样）：整个根目录按变了报。
    if (name === null) this.queueRelativePath(rootPath, WorkbenchWatchWholeRootPath)
    else this.queuePath(rootPath, name)
  }

  private queuePath(rootPath: string, filename: string): void {
    const path = normalizeRelativePath(rootPath, filename)
    if (path) this.queueRelativePath(rootPath, path)
  }

  private queueRelativePath(rootPath: string, path: string): void {
    const rootWatch = this.roots.get(rootPath)
    if (!rootWatch) return

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
