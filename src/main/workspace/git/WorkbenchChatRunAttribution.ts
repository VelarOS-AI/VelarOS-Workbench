import { realpathSync } from 'node:fs'
import { isAbsolute, posix, relative, resolve } from 'node:path'

import type { WorkbenchChatRunFileAttribution } from '../../../shared/workbenchGit'
import type { WorkbenchRawPathSource } from '../watch/WorkbenchFileWatcher'

/**
 * 命令结束后再等这么久：监听事件的到达延迟、子进程最后几笔落盘都还算在这条命令头上。最终采集也等它走完
 * 再拍工作树。
 */
export const AgentCommandGraceMs = 1_000
/** 写文件工具结束后，它自己那几笔写入的监听回声最迟这么久到达。 */
const AgentFileWriteEchoGraceMs = 1_000
/** 一轮最多记这么多个不同路径；再多说明这一轮动了海量文件，归属退回保守结论（一律算混改）。 */
const MaxTrackedPaths = 100_000
/** 写文件工具还没结束时暂存的回声候选上限；再多直接算作 AI 之外的改动（保守的一边）。 */
const MaxPendingEchoes = 10_000
/** 同时存在的账本上限：每轮一本、收尾即释放，只防渲染进程异常退出后留下的孤本越攒越多。 */
const MaxLedgers = 32
/** 版本库内部与依赖目录：改动永远不进「本轮改动」，事件也不必记。 */
const UntrackedSegments: ReadonlySet<string> = new Set(['.git', 'node_modules'])

const MarkAgentCommand = 1
const MarkOutside = 2

/**
 * Agent 在项目里动手的痕迹，由执行栈按这一轮绑定后放进工具上下文：写文件工具报它改过的路径，命令报它跑的
 * 时间窗。改动归属账本据此认出哪些改动是 Agent 做的；这一轮没有账本（外部引擎、不是 git 仓库）时上报是空操作。
 */
export interface WorkbenchAgentProjectActivityPort {
  /** 一次写文件工具调用开始；返回的函数在调用结束时带上它报告改过的路径（失败时为空）调用一次。 */
  beginFileWrite(): (changedPaths: readonly string[]) => void
  /** 一条 Agent 命令开始执行；返回的函数在命令结束（跑完、失败、被取消都算）时调用一次。 */
  beginCommand(): () => void
}

/** 执行栈取上报口的那一面：每一轮按 (项目根, 会话) 绑一次。 */
export interface WorkbenchAgentProjectActivitySource {
  activityFor(request: { projectRoot: string; sessionId: string }): WorkbenchAgentProjectActivityPort
}

/** 用户在 Workbench 里亲手写的文件（编辑器保存、文件树里新建 / 改名 / 移动 / 删除）。 */
export interface WorkbenchUserWriteSink {
  recordUserWrites(request: { workspaceRoot: string; paths: readonly string[] }): void
}

/** 一次写入（Project 内核事务、写文件工具）结果里报告改过的路径（相对项目根）；没有就是空清单。 */
export function readReportedChangedFiles(result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  const changedFiles = (result as { changedFiles?: unknown }).changedFiles
  return Array.isArray(changedFiles)
    ? changedFiles.filter((path): path is string => typeof path === 'string')
    : []
}

/** 从工具上下文里取这一轮的上报口；形状不对当作没有。 */
export function readWorkbenchAgentProjectActivity(
  toolContext: unknown
): WorkbenchAgentProjectActivityPort | undefined {
  if (!toolContext || typeof toolContext !== 'object') return undefined
  const port = (toolContext as { projectActivity?: unknown }).projectActivity
  if (!port || typeof port !== 'object') return undefined
  const candidate = port as Partial<WorkbenchAgentProjectActivityPort>
  return typeof candidate.beginFileWrite === 'function' && typeof candidate.beginCommand === 'function'
    ? (port as WorkbenchAgentProjectActivityPort)
    : undefined
}

/**
 * 一轮的归属结论。`watcher` 为 `unavailable`：这一轮的文件监听没起来或中途出错，命令的副作用与 AI 之外的
 * 改动都认不全，只有写文件工具报的路径算 Agent 的（见 {@link RunAttributionLedger.resolve}）。
 */
export interface WorkbenchChatRunAttributionResult {
  readonly watcher: 'observed' | 'unavailable'
  /** 相对项目根的路径 → 归属；不在表里的路径不是 Agent 改的。 */
  readonly origins: ReadonlyMap<string, WorkbenchChatRunFileAttribution>
}

interface RunLedgerRequest {
  workspaceRoot: string
  sessionId: string
  recordId: string
}

interface FileWriteWindow {
  readonly startedAt: number
  finishedAt: number | null
  /** 工具报告改过的路径；工具还没结束时为 null。 */
  paths: ReadonlySet<string> | null
}

/**
 * 一轮运行的改动归属账本。
 *
 * - 写文件工具（`project:write` / `edit` / `rollback`）报告改过的路径：确定是 Agent 的。
 * - Agent 命令执行期间（开始到结束，再加 {@link AgentCommandGraceMs}）监听到的路径：算 Agent 命令的副作用。
 * - 其余监听到的路径、用户在 Workbench 里亲手写的、同一项目里别的会话的 Agent 写的：不是这一轮 Agent 的。
 *   写文件工具自己那几笔写入的监听回声（路径在它报告的清单里，或是清单里文件的上级目录）不算。
 *
 * 某个路径（或它的上级目录）两边都沾过就是「混改」。目录级事件（改名、删除整个目录）按上级目录落到
 * 其下每个文件。
 */
class RunAttributionLedger {
  private readonly marks = new Map<string, number>()
  private readonly agentWrites = new Set<string>()
  private readonly fileWrites = new Set<FileWriteWindow>()
  private pendingEchoes: Array<{ path: string; at: number }> = []
  private activeCommands = 0
  private lastCommandEndedAt = Number.NEGATIVE_INFINITY
  private watcherLost = false
  private overflowed = false
  private stopObserving: (() => void) | null = null
  private disposedState = false

  public constructor(
    public readonly rootKey: string,
    public readonly sessionId: string,
    public readonly recordId: string,
    private readonly now: () => number
  ) {}

  public get disposed(): boolean {
    return this.disposedState
  }

  public attachObservation(stop: () => void): void {
    this.stopObserving = stop
  }

  public loseWatcher(): void {
    this.watcherLost = true
  }

  public dispose(): void {
    if (this.disposedState) return
    this.disposedState = true
    this.stopObserving?.()
    this.stopObserving = null
  }

  public observePath(path: string): void {
    if (this.disposedState || isUntrackedPath(path)) return
    const at = this.now()
    if (this.activeCommands > 0 || at <= this.lastCommandEndedAt + AgentCommandGraceMs) {
      this.mark(path, MarkAgentCommand)
      return
    }
    let writeRunning = false
    for (const write of this.fileWrites) {
      if (write.finishedAt !== null && at > write.finishedAt + AgentFileWriteEchoGraceMs) {
        this.fileWrites.delete(write)
        continue
      }
      if (write.startedAt > at) continue
      if (!write.paths) writeRunning = true
      else if (touchesPaths(path, write.paths)) return
    }
    // 写文件工具还没报出它改了哪些路径：先记着，等它结束再认是不是它的回声。
    if (writeRunning && this.pendingEchoes.length < MaxPendingEchoes)
      this.pendingEchoes.push({ path, at })
    else this.mark(path, MarkOutside)
  }

  public beginFileWrite(): (changedPaths: readonly string[]) => void {
    const write: FileWriteWindow = { startedAt: this.now(), finishedAt: null, paths: null }
    this.fileWrites.add(write)
    let finished = false
    return (changedPaths) => {
      if (finished) return
      finished = true
      write.finishedAt = this.now()
      write.paths = new Set(changedPaths)
      for (const path of changedPaths) this.agentWrites.add(path)
      this.pendingEchoes = this.pendingEchoes.filter(
        (echo) => !(echo.at >= write.startedAt && touchesPaths(echo.path, write.paths!))
      )
      this.settlePendingEchoes(false)
    }
  }

  public beginCommand(): () => void {
    this.activeCommands += 1
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.activeCommands -= 1
      this.lastCommandEndedAt = this.now()
    }
  }

  public recordOutside(paths: readonly string[]): void {
    for (const path of paths) if (!isUntrackedPath(path)) this.mark(path, MarkOutside)
  }

  /** 最终采集拍工作树之前还要等多久：最后一条命令的余量走完（命令还没结束时最多再等一个余量）。 */
  public settleDelayMs(): number {
    if (this.activeCommands > 0) return AgentCommandGraceMs
    const remaining = this.lastCommandEndedAt + AgentCommandGraceMs - this.now()
    return Math.min(Math.max(0, remaining), AgentCommandGraceMs)
  }

  /**
   * 这些路径各归谁。`final`：这一轮已经结束，还在等回声认领的事件一律算 AI 之外的改动。
   *
   * 文件监听不可用时只认写文件工具报的路径（不是整个 diff，也不是命令期间零星收到的那些）：命令的副作用
   * 认不出来，AI 之外的改动也可能漏记，宁可少认，不把用户的改动算成 Agent 的、回溯时替用户撤掉。
   */
  public resolve(paths: readonly string[], final: boolean): WorkbenchChatRunAttributionResult {
    if (final) this.settlePendingEchoes(true)
    const origins = new Map<string, WorkbenchChatRunFileAttribution>()
    for (const path of paths) {
      const marks = this.readMarks(path)
      const byTool = this.agentWrites.has(path)
      const byCommand = !this.watcherLost && (marks & MarkAgentCommand) !== 0
      if (!byTool && !byCommand) continue
      origins.set(path, this.overflowed || (marks & MarkOutside) !== 0 ? 'mixed' : 'agent')
    }
    return { watcher: this.watcherLost ? 'unavailable' : 'observed', origins }
  }

  private settlePendingEchoes(all: boolean): void {
    if (this.pendingEchoes.length === 0) return
    const kept: Array<{ path: string; at: number }> = []
    for (const echo of this.pendingEchoes) {
      const awaited = !all && [...this.fileWrites].some(
        (write) => !write.paths && write.startedAt <= echo.at
      )
      if (awaited) kept.push(echo)
      else this.mark(echo.path, MarkOutside)
    }
    this.pendingEchoes = kept
  }

  private mark(path: string, flag: number): void {
    const current = this.marks.get(path)
    if (current === undefined && this.marks.size >= MaxTrackedPaths) {
      this.overflowed = true
      return
    }
    this.marks.set(path, (current ?? 0) | flag)
  }

  /** 路径本身与它每一级上级目录的标记合在一起。 */
  private readMarks(path: string): number {
    let flags = this.marks.get(path) ?? 0
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1))
      flags |= this.marks.get(path.slice(0, cut)) ?? 0
    return flags
  }
}

/**
 * 「本轮改动」的归属：每一轮开跑前开一本账（{@link RunAttributionLedger}），运行中由文件监听、执行栈与
 * Workbench 的写入口往里记，采集时拿它筛出 Agent 改的那些文件，最终采集写完即关账。
 *
 * 账本按 (项目根, 会话, 记录 id) 认；同一个会话眼下在跑的那一轮是 Agent 上报的去处。
 */
export class WorkbenchChatRunAttribution
implements WorkbenchAgentProjectActivitySource, WorkbenchUserWriteSink {
  private readonly ledgers = new Map<string, RunAttributionLedger>()
  private readonly currentBySession = new Map<string, RunAttributionLedger>()
  private readonly rootKeys = new Map<string, string>()

  public constructor(
    private readonly watcher: WorkbenchRawPathSource,
    private readonly now: () => number = Date.now
  ) {}

  /** 这一轮开跑前：开账并开始听项目里的文件事件。不抛错——听不了就记下，这一轮只认写文件工具的路径。 */
  public async begin(request: RunLedgerRequest): Promise<void> {
    const rootKey = this.rootKey(request.workspaceRoot)
    const key = recordKey(rootKey, request.sessionId, request.recordId)
    this.release(this.ledgers.get(key))
    const ledger = new RunAttributionLedger(rootKey, request.sessionId, request.recordId, this.now)
    this.ledgers.set(key, ledger)
    this.currentBySession.set(sessionKey(rootKey, request.sessionId), ledger)
    for (const stale of [...this.ledgers.values()].slice(0, Math.max(0, this.ledgers.size - MaxLedgers)))
      this.release(stale)

    try {
      const observation = await this.watcher.observeRawPaths(request.workspaceRoot, {
        onPath: (path) => ledger.observePath(path),
        onError: () => ledger.loseWatcher(),
      })
      if (ledger.disposed) observation.stop()
      else ledger.attachObservation(observation.stop)
    } catch {
      ledger.loseWatcher()
    }
  }

  public activityFor(request: {
    projectRoot: string
    sessionId: string
  }): WorkbenchAgentProjectActivityPort {
    const rootKey = this.rootKey(request.projectRoot)
    const currentLedger = (): RunAttributionLedger | undefined =>
      this.currentBySession.get(sessionKey(rootKey, request.sessionId))
    return {
      beginFileWrite: () => {
        const ledger = currentLedger()
        const finish = ledger?.beginFileWrite()
        return (changedPaths) => {
          const paths = normalizeRelativePaths(changedPaths, [])
          finish?.(paths)
          // 同一个项目里别的会话正在记的账：这是别的 Agent 写的，对它们不算自己 Agent 的改动。
          for (const other of this.ledgers.values())
            if (other.rootKey === rootKey && other.sessionId !== request.sessionId)
              other.recordOutside(paths)
        }
      },
      beginCommand: () => currentLedger()?.beginCommand() ?? noop,
    }
  }

  public recordUserWrites(request: { workspaceRoot: string; paths: readonly string[] }): void {
    if (this.ledgers.size === 0) return
    const rootKey = this.rootKey(request.workspaceRoot)
    const paths = normalizeRelativePaths(request.paths, [resolve(request.workspaceRoot), rootKey])
    if (paths.length === 0) return
    for (const ledger of this.ledgers.values())
      if (ledger.rootKey === rootKey) ledger.recordOutside(paths)
  }

  /** 最终采集拍工作树前还要等多久；没有账本时不等。 */
  public settleDelayMs(request: RunLedgerRequest): number {
    return this.find(request)?.settleDelayMs() ?? 0
  }

  /** 这一轮里这些路径各归谁；没有账本（没开账、已作废或被挤掉）时为 null。 */
  public resolve(
    request: RunLedgerRequest,
    paths: readonly string[],
    options: { final: boolean }
  ): WorkbenchChatRunAttributionResult | null {
    return this.find(request)?.resolve(paths, options.final) ?? null
  }

  /** 最终采集已经写完：关账。 */
  public finish(request: RunLedgerRequest): void {
    this.release(this.find(request))
  }

  /** 这一轮不会再有采集（检查点没拍成、记录被删、会话被移除）：账本作废。不给记录 id 就是整个会话。 */
  public discard(request: { workspaceRoot: string; sessionId: string; recordIds?: readonly string[] }): void {
    const rootKey = this.rootKey(request.workspaceRoot)
    const recordIds = request.recordIds ? new Set(request.recordIds) : null
    for (const ledger of [...this.ledgers.values()]) {
      if (
        ledger.rootKey === rootKey
        && ledger.sessionId === request.sessionId
        && (!recordIds || recordIds.has(ledger.recordId))
      ) this.release(ledger)
    }
  }

  private find(request: RunLedgerRequest): RunAttributionLedger | undefined {
    return this.ledgers.get(
      recordKey(this.rootKey(request.workspaceRoot), request.sessionId, request.recordId)
    )
  }

  private release(ledger: RunAttributionLedger | undefined): void {
    if (!ledger) return
    ledger.dispose()
    const key = recordKey(ledger.rootKey, ledger.sessionId, ledger.recordId)
    if (this.ledgers.get(key) === ledger) this.ledgers.delete(key)
    const session = sessionKey(ledger.rootKey, ledger.sessionId)
    if (this.currentBySession.get(session) === ledger) this.currentBySession.delete(session)
  }

  /** 项目根按真实路径认：监听器报的是真实根目录下的事件，renderer 传来的根可能经过符号链接。 */
  private rootKey(workspaceRoot: string): string {
    const resolved = resolve(workspaceRoot)
    const cached = this.rootKeys.get(resolved)
    if (cached) return cached
    try {
      const real = realpathSync.native(resolved)
      this.rootKeys.set(resolved, real)
      return real
    } catch {
      // 目录已经不在：按规范化路径认（不缓存，目录回来后照常解析）。
      return resolved
    }
  }
}

function noop(): void {}

function recordKey(rootKey: string, sessionId: string, recordId: string): string {
  return `${rootKey}\0${sessionId}\0${recordId}`
}

function sessionKey(rootKey: string, sessionId: string): string {
  return `${rootKey}\0${sessionId}`
}

function isUntrackedPath(path: string): boolean {
  return path.split('/').some((segment) => UntrackedSegments.has(segment))
}

/** 路径就是清单里的某个文件，或是清单里某个文件的上级目录（写入时顺带建出来的）。 */
function touchesPaths(path: string, paths: ReadonlySet<string>): boolean {
  if (paths.has(path)) return true
  const prefix = `${path}/`
  for (const candidate of paths) if (candidate.startsWith(prefix)) return true
  return false
}

/**
 * 统一成相对项目根、`/` 分隔的路径；绝对路径按给定的根（renderer 传来的根、真实根）换算，落在根外的丢掉。
 */
function normalizeRelativePaths(paths: readonly string[], roots: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const raw of paths) {
    const input = raw.trim()
    if (!input || input.includes('\0')) continue
    const candidates = isAbsolute(input)
      ? roots.map((root) => relative(root, input))
      : [input]
    for (const candidate of candidates) {
      const path = posix.normalize(candidate.replaceAll('\\', '/')).replace(/\/+$/u, '')
      if (!path || path === '.' || path === '..' || path.startsWith('../') || path.startsWith('/'))
        continue
      normalized.add(path)
      break
    }
  }
  return [...normalized]
}
