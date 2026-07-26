import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import type { SystemWorkspaceFilesChangedEvent } from '@velaros-ai/workbench/contracts'
import { shouldSkipWorkspaceToolDirectory } from '@velaros-ai/workspace'

const WorkbenchWatchDebounceMs = 120

interface RootWatch {
  watcher: FSWatcher
  subscriptions: Set<string>
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
}

function normalizeRelativePath(rootPath: string, filename: string): Nullable<string> {
  const absolutePath = resolve(rootPath, filename)
  const path = relative(rootPath, absolutePath).replace(/\\/g, '/')
  if (!path || path === '.' || path.startsWith('../') || path === '..') return null

  const segments = path.split('/').filter(Boolean)
  const isGitState =
    segments[0] === '.git' &&
    (segments[1] === 'HEAD' ||
      segments[1] === 'index' ||
      segments[1] === 'packed-refs' ||
      segments[1] === 'refs')
  if (isGitState) return path
  if (segments.some((segment) => shouldSkipWorkspaceToolDirectory(segment))) return null

  return path
}

/**
 * 独立 Workbench 的项目文件监听器。
 *
 * 同一真实根目录只持有一个递归 fs.watch；renderer 订阅以 UUID 隔离，根事件在 120ms
 * 窗口内合并后逐订阅投递。服务不依赖 Desktop session，也不写 Agent signals。
 */
export class WorkbenchFileWatcher {
  private readonly roots = new Map<string, RootWatch>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly debounceMs: number
  private readonly now: () => number

  constructor(dependencies: WorkbenchFileWatcherDependencies = {}) {
    this.debounceMs = dependencies.debounceMs ?? WorkbenchWatchDebounceMs
    this.now = dependencies.now ?? Date.now
  }

  public async subscribe(
    workspaceRoot: string,
    listener: (event: SystemWorkspaceFilesChangedEvent) => void
  ): Promise<{ subscriptionId: string; workspaceRoot: string }> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const subscriptionId = randomUUID()

    let rootWatch = this.roots.get(rootPath)
    if (!rootWatch) {
      const watcher = watch(rootPath, { persistent: true, recursive: true }, (_event, filename) => {
        if (!filename) return
        this.queuePath(rootPath, filename.toString())
      })
      rootWatch = {
        watcher,
        subscriptions: new Set(),
        paths: new Set(),
        timer: null,
      }
      watcher.on('error', () => {
        // 单次监听错误不伪造文件事件；订阅仍保留，让平台 watcher 自己恢复或由项目切换释放。
      })
      this.roots.set(rootPath, rootWatch)
    }

    rootWatch.subscriptions.add(subscriptionId)
    this.subscriptions.set(subscriptionId, { rootPath, listener })
    return { subscriptionId, workspaceRoot: rootPath }
  }

  public unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return

    this.subscriptions.delete(subscriptionId)
    const rootWatch = this.roots.get(subscription.rootPath)
    if (!rootWatch) return

    rootWatch.subscriptions.delete(subscriptionId)
    if (rootWatch.subscriptions.size > 0) return

    if (rootWatch.timer) clearTimeout(rootWatch.timer)
    rootWatch.watcher.close()
    this.roots.delete(subscription.rootPath)
  }

  public dispose(): void {
    for (const rootWatch of this.roots.values()) {
      if (rootWatch.timer) clearTimeout(rootWatch.timer)
      rootWatch.watcher.close()
    }
    this.roots.clear()
    this.subscriptions.clear()
  }

  private async resolveRoot(input: string): Promise<string> {
    if (!input.trim()) throw new AppError('VALIDATION', '需要选择一个工程目录。')

    const candidate = resolve(input)
    const info = await stat(candidate).catch(() => null)
    if (!info?.isDirectory()) throw new AppError('VALIDATION', '需要选择一个工程目录。')

    return realpath(candidate)
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
    for (const subscriptionId of rootWatch.subscriptions) {
      this.subscriptions.get(subscriptionId)?.listener(event)
    }
  }
}
