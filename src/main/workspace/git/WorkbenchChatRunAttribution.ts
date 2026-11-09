import { realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'

import type { WorkbenchChatRunFileAttribution } from '../../../shared/workbenchGit'
import type { WorkbenchRawPathSource } from '../watch/WorkbenchFileWatcher'

/** 命令结束后再等这么久：子进程最后几笔落盘还算在这条命令头上。最终采集也等它走完再拍工作树。 */
export const AgentCommandGraceMs = 1_000
/**
 * 改动时刻与工具时间窗比较时两头各放宽这么多：窗口的起止是在回调里取的时刻，与文件系统记下的时间戳之间
 * 有几毫秒的出入。
 */
const ChangeTimeSlackMs = 50
/** 一轮最多记这么多个不同路径；再多说明这一轮动了海量文件，归属退回保守结论（一律算混改）。 */
const MaxTrackedPaths = 100_000
/** 写文件工具还没结束时暂存的回声候选上限；再多直接算作 AI 之外的改动（保守的一边）。 */
const MaxPendingEchoes = 10_000
/** 一轮最多记这么多个工具时间窗；再多同样退回保守结论。 */
const MaxActionWindows = 10_000
/** 补判改动时刻时同时读的路径数。 */
const ChangeTimeReadConcurrency = 64
/** 同时存在的账本上限：每轮一本、收尾即释放，只防渲染进程异常退出后留下的孤本越攒越多。 */
const MaxLedgers = 32
/** 版本库内部与依赖目录：改动永远不进「本轮改动」，事件也不必记。 */
const UntrackedSegments: ReadonlySet<string> = new Set(['.git', 'node_modules'])

const MarkAgentCommand = 1
const MarkOutside = 2

/**
 * 一个路径此刻的改动时刻（ctime，毫秒）；路径不在为 null，读不了就抛错。
 *
 * 改动归属按「改动发生在什么时候」判断，不按监听事件什么时候到：macOS 在机器忙的时候会把文件事件攒上
 * 好几秒再成批送达（Agent 跑构建、装依赖时正是最忙的时候），按到达时刻判，命令的产物会落到命令窗之后、
 * 命令开跑前用户的改动会落进命令窗里。ctime 由文件系统在改动那一刻记下，用户工具改不了它（mtime 会被
 * tar、`cp -p` 回填成旧值）；写文件改的是文件自己的 ctime，删除、改名改的是上级目录的。
 */
export type WorkbenchPathChangeTimeReader = (absolutePath: string) => Promise<number | null>

export async function readPathChangeTime(absolutePath: string): Promise<number | null> {
  try {
    return (await lstat(absolutePath)).ctimeMs
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

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

/**
 * 一轮的归属结论。`watcher` 为 `unavailable`：这一轮的文件监听没起来或中途出错。改动时刻照样补判得出来，
 * 只是一个文件先后被两边改过的经过看不全，「混改」只认得出明确报过的那些（见 {@link RunAttributionLedger}）。
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

interface ActionWindow {
  readonly startedAt: number
  /** 还没结束时为 null。 */
  finishedAt: number | null
}

interface FileWriteWindow extends ActionWindow {
  /** 工具报告改过的路径；工具还没结束时为 null。 */
  paths: ReadonlySet<string> | null
}

/**
 * 一轮运行的改动归属账本。每一次改动按它发生的时刻（{@link WorkbenchPathChangeTimeReader}）归到这一轮的
 * 工具时间窗里：
 *
 * - 写文件工具（`project:file` / `edit` / `change`）报告改过的路径：确定是 Agent 的。它自己那几笔写入
 *   的监听回声（改动时刻落在这次写入的时间窗里，路径在它报告的清单里或是清单里文件的上级目录）不另算。
 * - 改动时刻落在 Agent 命令执行期间（开始到结束，再加 {@link AgentCommandGraceMs}）：算命令的副作用。
 * - 其余的改动、用户在 Workbench 里亲手写的、同一项目里别的会话的 Agent 写的：不是这一轮 Agent 的。
 *
 * 监听事件一到就读那个路径的改动时刻（已经不在的按最近的在世上级目录，且不晚于事件到达）。采集时再按
 * 改动了的路径此刻的改动时刻看一遍（{@link RunAttributionLedger.reviewChangedPaths}）：一个事件都没记上的
 * （事件还在路上、被合并掉，或监听不可用）当场补判；已经认作 Agent 的，此刻的改动时刻不是 Agent 哪次动作
 * 留下的，说明之后有人改过。
 *
 * 某个路径（或它的上级目录）两边都沾过就是「混改」。目录级事件（改名、删除整个目录）按上级目录落到
 * 其下每个文件。只剩一种经过认不出：AI 之外的改动还没来得及报到，同一个文件就被 Agent 接着改了——两次改动
 * 合成一个事件，只看得到后一次的时刻。
 */
class RunAttributionLedger {
  private readonly marks = new Map<string, number>()
  private readonly agentWrites = new Set<string>()
  /**
   * 写文件工具删掉的路径：报告里有、那次写入结束时已经不在。删除的事件要是晚到、同一目录其间又有改动，
   * 按上级目录推出的时刻会落到别的窗里——认它就是 Agent 的删除，回溯时照样重建。
   */
  private readonly agentDeletions = new Set<string>()
  /** 还没读完的「写入结束时哪些路径已经不在」。 */
  private readonly deletionChecks = new Set<Promise<void>>()
  private readonly fileWrites: FileWriteWindow[] = []
  private readonly commands: ActionWindow[] = []
  private pendingEchoes: Array<{ path: string; at: number }> = []
  /** 已到达、正在读改动时刻的事件；采集前等它们判完。 */
  private readonly inFlight = new Set<Promise<void>>()
  private lastCommandEndedAt = Number.NEGATIVE_INFINITY
  private watcherLost = false
  private overflowed = false
  private stopObserving: (() => void) | null = null
  private disposedState = false
  private readonly startedAt: number

  public constructor(
    public readonly rootKey: string,
    public readonly sessionId: string,
    public readonly recordId: string,
    private readonly now: () => number,
    private readonly readChangeTime: WorkbenchPathChangeTimeReader
  ) {
    this.startedAt = now()
  }

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
    const arrivedAt = this.now()
    this.track(this.inFlight, this.eventChangeTime(path, arrivedAt).then(
      (changedAt) => {
        if (changedAt !== 'agent-deletion') this.classifyEvent(path, changedAt)
      },
      () => this.mark(path, MarkOutside)
    ))
  }

  /** 跟踪一个不会失败的后台判定，判完自己移除。 */
  private track(tasks: Set<Promise<void>>, task: Promise<void>): void {
    tasks.add(task)
    void task.then(() => tasks.delete(task))
  }

  public beginFileWrite(): (changedPaths: readonly string[]) => void {
    const write: FileWriteWindow = { startedAt: this.now(), finishedAt: null, paths: null }
    this.trackWindow(this.fileWrites, write)
    let finished = false
    return (changedPaths) => {
      if (finished) return
      finished = true
      write.finishedAt = this.now()
      write.paths = new Set(changedPaths)
      for (const path of changedPaths) this.agentWrites.add(path)
      this.settlePendingEchoes(false)
      this.track(this.deletionChecks, this.recordAgentDeletions(changedPaths))
    }
  }

  private async recordAgentDeletions(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map(async (path) => {
      const changedAt = await this.readChangeTime(this.absolute(path)).catch(() => undefined)
      if (changedAt === null) this.agentDeletions.add(path)
      else if (changedAt !== undefined) this.agentDeletions.delete(path)
    }))
  }

  public beginCommand(): () => void {
    const command: ActionWindow = { startedAt: this.now(), finishedAt: null }
    this.trackWindow(this.commands, command)
    let finished = false
    return () => {
      if (finished) return
      finished = true
      command.finishedAt = this.now()
      this.lastCommandEndedAt = Math.max(this.lastCommandEndedAt, command.finishedAt)
    }
  }

  public recordOutside(paths: readonly string[]): void {
    for (const path of paths) if (!isUntrackedPath(path)) this.mark(path, MarkOutside)
  }

  /** 最终采集拍工作树之前还要等多久：最后一条命令的余量走完（命令还没结束时最多再等一个余量）。 */
  public settleDelayMs(): number {
    if (this.commands.some((command) => command.finishedAt === null)) return AgentCommandGraceMs
    const remaining = this.lastCommandEndedAt + AgentCommandGraceMs - this.now()
    return Math.min(Math.max(0, remaining), AgentCommandGraceMs)
  }

  /**
   * 这些路径各归谁。先等已到达的事件判完，再按此刻的改动时刻把这些路径看一遍。`final`：这一轮已经结束，
   * 还在等回声认领的事件一律算 AI 之外的改动。
   */
  public async resolve(
    paths: readonly string[],
    final: boolean
  ): Promise<WorkbenchChatRunAttributionResult> {
    while (this.inFlight.size > 0 || this.deletionChecks.size > 0)
      await Promise.all([...this.inFlight, ...this.deletionChecks])
    if (final) this.settlePendingEchoes(true)
    await this.reviewChangedPaths(paths)
    const origins = new Map<string, WorkbenchChatRunFileAttribution>()
    for (const path of paths) {
      const marks = this.readMarks(path)
      const byTool = this.agentWrites.has(path)
      const byCommand = (marks & MarkAgentCommand) !== 0
      if (!byTool && !byCommand) continue
      origins.set(path, this.overflowed || (marks & MarkOutside) !== 0 ? 'mixed' : 'agent')
    }
    return { watcher: this.watcherLost ? 'unavailable' : 'observed', origins }
  }

  /**
   * 一次事件的改动发生在什么时候：路径还在就是它的 ctime；已经不在（删掉、移走）就是最近的在世上级目录的
   * ctime，再不晚于事件到达的时刻——真正删除的那一刻不晚于这两者。写文件工具删掉的路径是它自己的删除
   * （`agent-deletion`）。读不了按到达时刻算。
   */
  private async eventChangeTime(path: string, arrivedAt: number): Promise<number | 'agent-deletion'> {
    try {
      const own = await this.readChangeTime(this.absolute(path))
      if (own !== null) return own
      while (this.deletionChecks.size > 0) await Promise.all([...this.deletionChecks])
      if (this.agentDeletions.has(path)) return 'agent-deletion'
      const ancestor = await this.nearestAncestorChangeTime(path, () => true)
      return ancestor === null ? arrivedAt : Math.min(ancestor, arrivedAt)
    } catch {
      return arrivedAt
    }
  }

  private classifyEvent(path: string, changedAt: number): void {
    // 改在这一轮开跑之前的（事件晚到）：已经在检查点里，不是这一轮任何人的改动。
    if (this.disposedState || changedAt < this.startedAt - ChangeTimeSlackMs) return
    if (this.inCommandWindow(changedAt)) {
      this.mark(path, MarkAgentCommand)
      return
    }
    const echo = this.echoOf(path, changedAt)
    if (echo === 'echo') return
    // 写文件工具还没报出它改了哪些路径：先记着，等它结束再认是不是它的回声。
    if (echo === 'pending' && this.pendingEchoes.length < MaxPendingEchoes)
      this.pendingEchoes.push({ path, at: changedAt })
    else this.mark(path, MarkOutside)
  }

  /** 改动时刻落在某次写文件工具的时间窗里、路径在它报告的清单里：是它的回声；那次写入还没报结果：待定。 */
  private echoOf(path: string, changedAt: number): 'echo' | 'pending' | null {
    let pending = false
    for (const write of this.fileWrites) {
      if (changedAt < write.startedAt - ChangeTimeSlackMs) continue
      if (write.finishedAt === null) pending = true
      else if (changedAt <= write.finishedAt + ChangeTimeSlackMs && touchesPaths(path, write.paths!))
        return 'echo'
    }
    return pending ? 'pending' : null
  }

  private inCommandWindow(changedAt: number): boolean {
    return this.commands.some(
      (command) =>
        changedAt >= command.startedAt - ChangeTimeSlackMs
        && (command.finishedAt === null || changedAt <= command.finishedAt + AgentCommandGraceMs)
    )
  }

  /**
   * 采集时按改动了的路径此刻的改动时刻再看一遍：
   *
   * - 一个事件都没记上的：按它补判。
   * - 已经认作 Agent 的（写文件工具报过，或改在命令窗里）：文件还在、此刻的改动时刻却不是 Agent 哪次动作
   *   留下的——之后有人改过（那个事件可能还没到），记成 AI 之外的改动。已经不在的交给回溯前的内容核对：
   *   删掉它的要是别人，内容就对不上 Agent 留下的样子。
   */
  private async reviewChangedPaths(paths: readonly string[]): Promise<void> {
    const candidates = paths.filter((path) => !isUntrackedPath(path))
    for (let start = 0; start < candidates.length; start += ChangeTimeReadConcurrency) {
      await Promise.all(
        candidates.slice(start, start + ChangeTimeReadConcurrency).map((path) => this.reviewChangedPath(path))
      )
    }
  }

  private async reviewChangedPath(path: string): Promise<void> {
    const marks = this.readMarks(path)
    if ((marks & MarkOutside) !== 0) return
    if (this.agentWrites.has(path) || (marks & MarkAgentCommand) !== 0) {
      const changedAt = await this.readChangeTime(this.absolute(path)).catch(() => null)
      // 改动时刻早于这一轮的：跟着整个目录改名、移动进来，看不出之后还有没有人动过。
      if (changedAt === null || changedAt < this.startedAt - ChangeTimeSlackMs || this.disposedState) return
      if (!this.inCommandWindow(changedAt) && this.echoOf(path, changedAt) === null)
        this.mark(path, MarkOutside)
      return
    }
    if (marks !== 0) return
    const changedAt = await this.currentChangeTime(path).catch(() => null)
    if (changedAt === null || this.disposedState) return
    if (this.inCommandWindow(changedAt)) this.mark(path, MarkAgentCommand)
    // 落在还没报结果的写入窗里：等它报了再说。
    else if (this.echoOf(path, changedAt) === null) this.mark(path, MarkOutside)
  }

  /**
   * 此刻看一个改动了的路径是什么时候改的。还在：它的 ctime；ctime 早于这一轮开跑的（跟着整个目录改名、
   * 移动进来的文件不更新自己的 ctime）按最近一个这一轮里变过的上级目录算，找不到就还是它自己的。已经
   * 不在：最近的在世上级目录的 ctime。
   */
  private async currentChangeTime(path: string): Promise<number | null> {
    const own = await this.readChangeTime(this.absolute(path))
    if (own === null) return this.nearestAncestorChangeTime(path, () => true)
    if (own >= this.startedAt - ChangeTimeSlackMs) return own
    return (await this.nearestAncestorChangeTime(
      path,
      (changedAt) => changedAt >= this.startedAt - ChangeTimeSlackMs
    )) ?? own
  }

  /** 由近及远第一个在世、且改动时刻满足 `accept` 的上级目录（含项目根）的改动时刻；没有为 null。 */
  private async nearestAncestorChangeTime(
    path: string,
    accept: (changedAt: number) => boolean
  ): Promise<number | null> {
    for (let cut = path.lastIndexOf('/'); ; cut = path.lastIndexOf('/', cut - 1)) {
      const changedAt = await this.readChangeTime(cut > 0 ? this.absolute(path.slice(0, cut)) : this.rootKey)
      if (changedAt !== null && accept(changedAt)) return changedAt
      if (cut <= 0) return null
    }
  }

  private absolute(path: string): string {
    return join(this.rootKey, path)
  }

  private trackWindow<T extends ActionWindow>(windows: T[], window: T): void {
    if (windows.length >= MaxActionWindows) this.overflowed = true
    else windows.push(window)
  }

  private settlePendingEchoes(all: boolean): void {
    if (this.pendingEchoes.length === 0) return
    const kept: Array<{ path: string; at: number }> = []
    for (const echo of this.pendingEchoes) {
      const echoOf = this.echoOf(echo.path, echo.at)
      if (echoOf === 'echo') continue
      if (echoOf === 'pending' && !all) kept.push(echo)
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
    private readonly now: () => number = Date.now,
    private readonly readChangeTime: WorkbenchPathChangeTimeReader = readPathChangeTime
  ) {}

  /**
   * 这一轮开跑前：开账并开始听项目里的文件事件。不抛错——听不了就记下，改动归属照样按采集时的改动时刻
   * 补判，只是先后两边都改过的经过认不全。
   */
  public async begin(request: RunLedgerRequest): Promise<void> {
    const rootKey = this.rootKey(request.workspaceRoot)
    const key = recordKey(rootKey, request.sessionId, request.recordId)
    this.release(this.ledgers.get(key))
    const ledger = new RunAttributionLedger(
      rootKey,
      request.sessionId,
      request.recordId,
      this.now,
      this.readChangeTime
    )
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
  public async resolve(
    request: RunLedgerRequest,
    paths: readonly string[],
    options: { final: boolean }
  ): Promise<WorkbenchChatRunAttributionResult | null> {
    return (await this.find(request)?.resolve(paths, options.final)) ?? null
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
