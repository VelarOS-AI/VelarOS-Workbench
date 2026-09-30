/**
 * 一次调试：一个带检查器的 Node 程序，加上连着它的一条 Chrome DevTools 协议连接。
 *
 * 断点是怎么落到代码上的：
 * - 没有 source map 的脚本（普通 JS、Node 直接跑的 TS）：按文件地址下断点（`setBreakpointByUrl`）。V8 在脚本
 *   编译时就把它落好，脚本还没加载时先挂着，加载了自己生效，没有「来不及」的问题。
 * - 带 source map 的脚本（编译产物、tsx 这类加载器就地转出来的代码）：脚本一加载就读它的 source map，把源码行
 *   换成生成代码里的位置，再按脚本下断点（`setBreakpoint`）。这一步是收到「脚本已解析」之后才做的，得抢在
 *   脚本开始执行之前——靠三个停顿点：`--inspect-brk` 的「启动即停」（主脚本此时已解析）、V8 的「带 source map
 *   的脚本执行前」停顿（只对 `vm` 编译的脚本有效，Vitest 就是）、以及给每个有断点的文件在第一行预先挂的
 *   「入口断点」（tsx、Jest 这类就地转换的，脚本地址就是源文件自己）。编译到别处的非主模块没有这样的停顿点，
 *   它顶层代码里的断点可能在绑上之前就跑过去了；函数里的断点不受影响。
 * - 就地转换的脚本里，按地址下的断点用的是生成代码的行号，是错的：认出来之后摘掉，只留按映射下的。
 *
 * 检查器的事件按到达顺序一件件处理（处理中可以等 source map 读完），界面来的命令也排在同一条队里。
 */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchDebuggerBreakpoint,
  WorkbenchDebuggerBreakpointStatus,
  WorkbenchDebuggerControlAction,
  WorkbenchDebuggerEndReason,
  WorkbenchDebuggerEvaluateResult,
  WorkbenchDebuggerEvent,
  WorkbenchDebuggerFrame,
  WorkbenchDebuggerLocation,
  WorkbenchDebuggerPauseReason,
  WorkbenchDebuggerScope,
  WorkbenchDebuggerScopeType,
  WorkbenchDebuggerVariablesResult,
} from '../../../shared/workbenchDebugger'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import { getRelativePathInsideRoot, toPortableRelativePath } from '../PathContainmentHelper'
import type { PathResolver } from '../PathResolver'

import { waitForInspectorEndpoint, type WorkbenchDebugProcess } from './WorkbenchDebugLaunch'
import {
  type InspectorPropertyDescriptor,
  type InspectorRemoteObject,
  toWorkbenchDebuggerValue,
  toWorkbenchDebuggerVariable,
} from './WorkbenchDebugValues'
import {
  WorkbenchInspectorConnection,
  type WorkbenchInspectorEvent,
} from './WorkbenchInspectorConnection'
import { decodeInlineSourceMap, WorkbenchSourceMap } from './WorkbenchSourceMap'

const log = Log.tag('WorkbenchDebugSession')
const InspectorConnectTimeoutMs = 5_000
/** 一次最多给界面这么多个属性：几十万项的数组不整个搬过去。 */
const MaxVariables = 500
/** 调用栈最多给这么多帧（失控的递归有上万帧）。 */
const MaxFrames = 200
/** 超过这么大的 source map 不读（压缩过的整包产物）：不值得为它卡住启动。 */
const MaxSourceMapBytes = 32 * 1024 * 1024
/** Node 自己的内部代码（`node:internal/…`、`node:fs`）：脚本地址以 `node:` 开头。 */
const NodeInternalScriptPattern = '^node:'
/** 求值、展开变量拿到的对象都放在这一组里，程序继续跑时一起放掉。 */
const ObjectGroup = 'workbench-debugger'
const ScopeTypes = new Set<WorkbenchDebuggerScopeType>([
  'block',
  'catch',
  'closure',
  'eval',
  'global',
  'local',
  'module',
  'script',
  'with',
])

interface InspectorLocation {
  scriptId: string
  lineNumber: number
  columnNumber?: number
}

interface InspectorCallFrame {
  callFrameId: string
  functionName: string
  location: InspectorLocation
  scopeChain: Array<{ type: string; name?: string; object: InspectorRemoteObject }>
}

interface ScriptRecord {
  id: string
  url: string
  /** 脚本在磁盘上的绝对路径；不是文件（Node 内部、`eval` 出来的）为 null。 */
  path: Nullable<string>
  /** 它的 source map；没有、读不了、不认的为 null。 */
  sourceMap: Nullable<WorkbenchSourceMap>
}

interface BreakpointRecord extends WorkbenchDebuggerBreakpoint {
  /** 文件的真实绝对路径；文件不在项目里（已经删了）为 null，这个断点永远对不上。 */
  absolutePath: Nullable<string>
  /** 按文件地址下的那个断点。 */
  urlBreakpointId: Nullable<string>
  /**
   * 经 source map 在各个脚本里下的断点：脚本 id → 断点 id。几个断点换算到同一处时（注释行顺延到下一句，
   * 下一句上也有断点）检查器只肯下一个，后来的记着先来的那个 id。
   */
  mappedBreakpointIds: Map<string, string>
  /** 已经落到代码上的断点 id → 落在源码的哪一行（从 1 起）。 */
  resolvedLines: Map<string, number>
}

export interface WorkbenchDebugSessionOptions {
  sessionId: string
  projectRoot: string
  process: WorkbenchDebugProcess
  port: number
  pathResolver: PathResolver
  breakpoints: readonly WorkbenchDebuggerBreakpoint[]
  pauseOnUncaughtExceptions: boolean
  /** 这条命令自己会在开头停一下（Vitest 的 `--inspect-brk`）：那一下不给用户看，直接放行。 */
  skipInitialPause: boolean
  attachTimeoutMs: number
  emit: (event: WorkbenchDebuggerEvent) => void
  /** 会话结束（不管怎么结束的）之后调一次，登记处据此把它摘掉。 */
  onEnded: () => void
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')
}

/**
 * 匹配这个文件的脚本地址的正则：Node 给模块的是 `file://` 地址（特殊字符按百分号编码），`vm` 里跑的脚本
 * （Jest）给的是原样的路径，两种都认。Windows 的盘符大小写不定。
 */
export function buildWorkbenchScriptUrlPattern(absolutePath: string): string {
  const variants = [pathToFileURL(absolutePath).href, absolutePath].map((variant) =>
    escapePattern(variant).replace(
      /^(file:\\\/\\\/\\\/)?([A-Za-z]):/u,
      (_match, scheme: string | undefined, drive: string) =>
        `${scheme ?? ''}[${drive.toUpperCase()}${drive.toLowerCase()}]:`
    )
  )
  return `^(?:${variants.join('|')})$`
}

/**
 * 入口断点用的地址正则：与用户断点那条等价，只是写法不同。检查器按「正则原文 + 行 + 列」认断点，用户正好在
 * 第一行下了断点时，两条写法一样的会被当成同一个而拒掉（Breakpoint at specified location already exists）。
 */
function buildEntryBreakpointPattern(absolutePath: string): string {
  return `(?:${buildWorkbenchScriptUrlPattern(absolutePath)})`
}

/** 脚本地址对应磁盘上的哪个文件；不是文件的给 null。 */
function scriptPathFromUrl(url: string): Nullable<string> {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url)
    } catch {
      // arch-guard:silent-catch-ok 不合法的 file: 地址：当作不是磁盘上的文件。
      return null
    }
  }
  return isAbsolute(url) ? url : null
}

function isDependencyPath(path: string): boolean {
  return path.split(sep).includes('node_modules')
}

export class WorkbenchDebugSession {
  public readonly sessionId: string
  public readonly process: WorkbenchDebugProcess
  private readonly options: WorkbenchDebugSessionOptions
  private connection: Nullable<WorkbenchInspectorConnection> = null
  /** 事件与命令排成一条队，一件做完再做下一件。 */
  private queue: Promise<void> = Promise.resolve()
  private readonly scripts = new Map<string, ScriptRecord>()
  private readonly breakpoints = new Map<string, BreakpointRecord>()
  /** 检查器的断点 id → 它属于哪个断点。 */
  private readonly breakpointsById = new Map<string, BreakpointRecord>()
  /** 入口断点：文件的绝对路径 → 断点 id，以及反过来。 */
  private readonly entryBreakpointIds = new Map<string, string>()
  private readonly entryBreakpointPaths = new Map<string, string>()
  /** 挂过的入口断点（摘掉的也算）：摘掉之前它可能已经让程序停下了，那次停顿照样认得出来。 */
  private readonly knownEntryBreakpointIds = new Set<string>()
  /** 按映射下的断点落在哪：`脚本 id:行:列` → 断点 id。 */
  private readonly mappedBreakpointLocations = new Map<string, string>()
  /** 按映射下的断点实际停在生成代码的哪一处（检查器回的）：断点 id → `脚本 id:行:列`。 */
  private readonly mappedBreakpointActualLocations = new Map<string, string>()
  /** 已经加载过脚本的文件：不必再为它挂入口断点。 */
  private readonly loadedPaths = new Set<string>()
  /** 就地转换的文件：脚本地址就是源文件，按地址下的断点行号不对，不再下。 */
  private readonly mappedInPlacePaths = new Set<string>()
  private mainContextId: Nullable<number> = null
  private pauseOnUncaughtExceptions: boolean
  private skipInitialPause: boolean
  /** 界面刚发过「暂停」或单步：下一次停下是它要的。 */
  private requestedPause: Nullable<'pause' | 'step'> = null
  /** 此刻停着，而且告诉过界面。 */
  private paused = false
  private lastBreakpointStatus = ''
  private stopRequested = false
  private ended = false

  public constructor(options: WorkbenchDebugSessionOptions) {
    this.options = options
    this.sessionId = options.sessionId
    this.process = options.process
    this.pauseOnUncaughtExceptions = options.pauseOnUncaughtExceptions
    this.skipInitialPause = options.skipInitialPause

    options.process.onExit(({ exitCode }) =>
      this.finish(this.stopRequested ? 'stopped' : 'exited', exitCode, null)
    )
    void this.attach()
  }

  /** 会话已经结束（程序退出了，或者根本没连上）。 */
  public get hasEnded(): boolean {
    return this.ended
  }

  /** 结束调试：断开检查器，结束整棵进程树。 */
  public async stop(): Promise<void> {
    this.stopRequested = true
    this.connection?.close()
    await this.process.stop()
    // 进程强杀之后还没报退出（僵住了）：会话这边照样收口。
    this.finish('stopped', null, null)
  }

  public control(action: WorkbenchDebuggerControlAction): Promise<void> {
    return this.enqueue(async () => {
      const connection = this.requireConnection()
      if (action === 'pause') {
        if (this.paused) return
        this.requestedPause = 'pause'
        await connection.send('Debugger.pause')
        return
      }
      // 继续与单步只在停着的时候有意义；程序在跑时按了 F10 不报错，也不记「下一次停下是单步」。
      if (!this.paused) return
      if (action === 'continue') {
        this.requestedPause = null
        await connection.send('Debugger.resume')
        return
      }
      this.requestedPause = 'step'
      await connection.send(
        action === 'step-over'
          ? 'Debugger.stepOver'
          : action === 'step-into'
            ? 'Debugger.stepInto'
            : 'Debugger.stepOut'
      )
    })
  }

  /** 整份换掉断点：多出来的摘掉，新加的下上；返回每个断点此刻对没对上代码。 */
  public setBreakpoints(
    breakpoints: readonly WorkbenchDebuggerBreakpoint[]
  ): Promise<WorkbenchDebuggerBreakpointStatus[]> {
    return this.enqueue(async () => {
      this.requireConnection()
      await this.applyBreakpoints(breakpoints)
      return this.breakpointStatuses()
    })
  }

  public setExceptionPause(uncaught: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.pauseOnUncaughtExceptions = uncaught
      await this.requireConnection().send('Debugger.setPauseOnExceptions', {
        state: uncaught ? 'uncaught' : 'none',
      })
    })
  }

  /** 展开一个对象或作用域：它自己的属性，外加内部属性（原型、Map 的项……）。 */
  public async getVariables(objectId: string): Promise<WorkbenchDebuggerVariablesResult> {
    const result = await this.requireConnection().send<{
      result?: InspectorPropertyDescriptor[]
      internalProperties?: InspectorPropertyDescriptor[]
      privateProperties?: InspectorPropertyDescriptor[]
    }>('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true })

    const descriptors = [
      ...(result.result ?? []),
      ...(result.privateProperties ?? []),
      ...(result.internalProperties ?? []),
    ]
    return {
      variables: descriptors.slice(0, MaxVariables).map(toWorkbenchDebuggerVariable),
      truncated: descriptors.length > MaxVariables,
    }
  }

  /** 求一个表达式的值：给了帧就在那一帧的作用域里，否则在全局。表达式抛的异常作为结果里的 `error` 返回。 */
  public async evaluate(
    expression: string,
    frameId: Nullable<string>,
    sideEffectFree: boolean
  ): Promise<WorkbenchDebuggerEvaluateResult> {
    const connection = this.requireConnection()
    const parameters = {
      expression,
      objectGroup: ObjectGroup,
      includeCommandLineAPI: true,
      // 求值时抛的异常不再让程序停在「异常断点」上。
      silent: true,
      generatePreview: true,
      throwOnSideEffect: sideEffectFree,
    }
    try {
      const result = await (frameId
        ? connection.send<{ result: InspectorRemoteObject; exceptionDetails?: InspectorException }>(
            'Debugger.evaluateOnCallFrame',
            { ...parameters, callFrameId: frameId }
          )
        : connection.send<{ result: InspectorRemoteObject; exceptionDetails?: InspectorException }>(
            'Runtime.evaluate',
            parameters
          ))
      if (result.exceptionDetails)
        return { value: null, error: describeException(result.exceptionDetails) }
      return { value: toWorkbenchDebuggerValue(result.result), error: null }
    } catch (error) {
      // 帧已经不在了（程序继续跑了）、连接断了：同样当作这次没求出来。
      return { value: null, error: AppError.from(error).message }
    }
  }

  /** 登记处在窗口关闭、应用退出时调：只断开检查器；进程由终端那边一起结束。 */
  public dispose(): void {
    this.stopRequested = true
    this.connection?.close()
  }

  private enqueue<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const result = this.queue.then(task)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private requireConnection(): WorkbenchInspectorConnection {
    if (!this.connection || this.connection.closed)
      throw new AppError('CLOSED', workbenchMainText('debug.sessionEnded'))
    return this.connection
  }

  private emit(event: WorkbenchDebuggerEvent): void {
    if (!this.ended) this.options.emit(event)
  }

  /** 等检查器起来、连上去、把断点与异常开关配好，再放程序开始跑。 */
  private async attach(): Promise<void> {
    try {
      const endpoint = await waitForInspectorEndpoint(this.options.port, {
        timeoutMs: this.options.attachTimeoutMs,
        isCancelled: () => this.ended || this.stopRequested,
      })
      if (this.ended || this.stopRequested) return
      if (!endpoint) throw new AppError('TIMEOUT', workbenchMainText('debug.attachTimedOut'))

      const connection = await WorkbenchInspectorConnection.connect(
        endpoint,
        InspectorConnectTimeoutMs
      )
      if (this.ended || this.stopRequested) {
        connection.close()
        return
      }
      this.connection = connection
      connection.onEvent((event) => {
        void this.enqueue(() => this.handleEvent(event)).catch((error: unknown) => {
          // 连接在处理途中断了是常态（程序退出）；别的错误记下来，不拖垮后面的事件。
          if (!connection.closed) log.warn('debug_event_failed', { method: event.method, error })
        })
      })
      connection.onClose(() => {
        this.paused = false
      })

      await this.enqueue(async () => {
        await connection.send('Runtime.enable')
        await connection.send('Debugger.enable')
        // 单步不进 Node 自己的内部代码。
        await connection.send('Debugger.setBlackboxPatterns', {
          patterns: [NodeInternalScriptPattern],
        })
        await connection.send('Debugger.setPauseOnExceptions', {
          state: this.pauseOnUncaughtExceptions ? 'uncaught' : 'none',
        })
        await connection
          .send('Debugger.setInstrumentationBreakpoint', {
            instrumentation: 'beforeScriptWithSourceMapExecution',
          })
          .catch(() => undefined)
        await this.applyBreakpoints(this.options.breakpoints)
        await connection.send('Runtime.runIfWaitingForDebugger')
      })
      this.emit({ type: 'attached', sessionId: this.sessionId })
      this.emitBreakpointStatus(true)
    } catch (error) {
      if (this.ended || this.stopRequested) return
      const message = AppError.from(error).message
      this.finish('failed', null, message)
      await this.process.stop().catch(() => undefined)
    }
  }

  private finish(
    reason: WorkbenchDebuggerEndReason,
    exitCode: Nullable<number>,
    message: Nullable<string>
  ): void {
    if (this.ended) return
    this.emit({ type: 'ended', sessionId: this.sessionId, reason, exitCode, message })
    this.ended = true
    this.paused = false
    this.connection?.close()
    this.options.onEnded()
  }

  private async handleEvent(event: WorkbenchInspectorEvent): Promise<void> {
    switch (event.method) {
      case 'Debugger.scriptParsed':
        await this.handleScriptParsed(event.params)
        return
      case 'Debugger.breakpointResolved':
        this.handleBreakpointResolved(event.params)
        return
      case 'Debugger.paused':
        await this.handlePaused(event.params)
        return
      case 'Debugger.resumed':
        this.handleResumed()
        return
      case 'Runtime.executionContextCreated': {
        const context = event.params.context as
          | { id?: number; auxData?: { isDefault?: boolean } }
          | undefined
        if (context?.auxData?.isDefault && typeof context.id === 'number')
          this.mainContextId ??= context.id
        return
      }
      case 'Runtime.executionContextDestroyed':
        // 程序跑完了，Node 还在等调试器断开才退出：断开它。
        if (event.params.executionContextId === this.mainContextId) this.connection?.close()
    }
  }

  // ── 脚本与 source map ────────────────────────────────────────────────────────

  private async handleScriptParsed(params: Record<string, unknown>): Promise<void> {
    const id = String(params.scriptId)
    const url = typeof params.url === 'string' ? params.url : ''
    const path = scriptPathFromUrl(url)
    const sourceMapUrl = typeof params.sourceMapURL === 'string' ? params.sourceMapURL : ''
    const script: ScriptRecord = {
      id,
      url,
      path,
      // 依赖包里的脚本不读映射：断点都在项目自己的文件里，读它们只会拖慢启动。
      sourceMap:
        path && sourceMapUrl && !isDependencyPath(path)
          ? await loadSourceMap(sourceMapUrl, path)
          : null,
    }
    this.scripts.set(id, script)
    if (!path) return

    this.loadedPaths.add(path)
    if (script.sourceMap) {
      await this.bindMappedBreakpoints(script)
    } else {
      // 普通脚本：按地址下的断点已经由 V8 落好，入口断点用不上了。
      await this.removeEntryBreakpoint(path)
    }
    this.emitBreakpointStatus()
  }

  /** 这个脚本带着 source map：把落在它的源文件里的断点换算成生成代码的位置，下在这个脚本上。 */
  private async bindMappedBreakpoints(script: ScriptRecord): Promise<void> {
    const map = script.sourceMap
    if (!map) return

    for (const breakpoint of this.breakpoints.values()) {
      if (!breakpoint.absolutePath || !map.hasSource(breakpoint.absolutePath)) continue
      await this.bindMappedBreakpoint(breakpoint, script)
    }
  }

  private async bindMappedBreakpoint(
    breakpoint: BreakpointRecord,
    script: ScriptRecord
  ): Promise<void> {
    const map = script.sourceMap
    const path = breakpoint.absolutePath
    if (!map || !path || breakpoint.mappedBreakpointIds.has(script.id)) return

    // 脚本地址就是源文件自己（就地转换）：按地址下的那个断点用的是生成代码的行号，摘掉。
    if (script.path === path) {
      this.mappedInPlacePaths.add(path)
      await this.removeUrlBreakpoint(breakpoint)
    }

    const generated = map.generatedPositionFor(path, breakpoint.line - 1)
    if (!generated) return

    const locationKey = `${script.id}:${generated.line}:${generated.column}`
    const existingId = this.mappedBreakpointLocations.get(locationKey)
    if (existingId) {
      // 另一个断点已经下在这一处：共用它。
      breakpoint.mappedBreakpointIds.set(script.id, existingId)
      breakpoint.resolvedLines.set(existingId, generated.originalLine + 1)
      return
    }
    try {
      const result = await this.requireConnection().send<{
        breakpointId: string
        actualLocation: InspectorLocation
      }>('Debugger.setBreakpoint', {
        location: {
          scriptId: script.id,
          lineNumber: generated.line,
          columnNumber: generated.column,
        },
      })
      const actual = map.originalPositionFor({
        line: result.actualLocation.lineNumber,
        column: result.actualLocation.columnNumber ?? 0,
      })
      breakpoint.mappedBreakpointIds.set(script.id, result.breakpointId)
      breakpoint.resolvedLines.set(
        result.breakpointId,
        (actual?.path === path ? actual.line : generated.originalLine) + 1
      )
      this.breakpointsById.set(result.breakpointId, breakpoint)
      this.mappedBreakpointLocations.set(locationKey, result.breakpointId)
      this.mappedBreakpointActualLocations.set(
        result.breakpointId,
        locationKeyOf(result.actualLocation)
      )
    } catch (error) {
      // 这个位置下不了断点（脚本已经被回收、位置越界）：这个脚本里就当没对上。
      log.debug('debug_mapped_breakpoint_failed', { scriptId: script.id, error })
    }
  }

  // ── 断点 ────────────────────────────────────────────────────────────────────

  private async applyBreakpoints(next: readonly WorkbenchDebuggerBreakpoint[]): Promise<void> {
    const wanted = new Map(next.map((breakpoint) => [breakpointKey(breakpoint), breakpoint]))
    for (const [key, record] of [...this.breakpoints]) {
      if (wanted.has(key)) continue
      this.breakpoints.delete(key)
      await this.removeBreakpoint(record)
    }
    for (const [key, breakpoint] of wanted) {
      if (this.breakpoints.has(key)) continue
      const record = await this.createBreakpointRecord(breakpoint)
      this.breakpoints.set(key, record)
      await this.addBreakpoint(record)
    }
    this.emitBreakpointStatus()
  }

  private async createBreakpointRecord(
    breakpoint: WorkbenchDebuggerBreakpoint
  ): Promise<BreakpointRecord> {
    const resolved = await this.options.pathResolver
      .resolveInsideProject(this.options.projectRoot, breakpoint.path)
      .catch(() => null)
    return {
      path: breakpoint.path,
      line: breakpoint.line,
      absolutePath: resolved?.realPath ?? null,
      urlBreakpointId: null,
      mappedBreakpointIds: new Map(),
      resolvedLines: new Map(),
    }
  }

  private async addBreakpoint(record: BreakpointRecord): Promise<void> {
    const path = record.absolutePath
    if (!path) return
    const connection = this.requireConnection()

    // 已经加载、带着映射的脚本：直接按映射下。
    for (const script of this.scripts.values()) {
      if (script.sourceMap?.hasSource(path)) await this.bindMappedBreakpoint(record, script)
    }
    if (!this.mappedInPlacePaths.has(path)) {
      const result = await connection.send<{
        breakpointId: string
        locations: InspectorLocation[]
      }>('Debugger.setBreakpointByUrl', {
        urlRegex: buildWorkbenchScriptUrlPattern(path),
        lineNumber: record.line - 1,
        columnNumber: 0,
      })
      record.urlBreakpointId = result.breakpointId
      this.breakpointsById.set(result.breakpointId, record)
      const location = result.locations[0]
      if (location) record.resolvedLines.set(result.breakpointId, location.lineNumber + 1)
    }
    // 这个文件的脚本还没加载：在它第一行挂一个入口断点，好在它开始执行之前停一下、把映射的断点下好。
    if (!this.loadedPaths.has(path) && !this.entryBreakpointIds.has(path)) {
      const entry = await connection.send<{ breakpointId: string }>('Debugger.setBreakpointByUrl', {
        urlRegex: buildEntryBreakpointPattern(path),
        lineNumber: 0,
        columnNumber: 0,
      })
      this.entryBreakpointIds.set(path, entry.breakpointId)
      this.entryBreakpointPaths.set(entry.breakpointId, path)
      this.knownEntryBreakpointIds.add(entry.breakpointId)
    }
  }

  /** 摘掉一个断点（它已经不在 `this.breakpoints` 里了）。 */
  private async removeBreakpoint(record: BreakpointRecord): Promise<void> {
    await this.removeUrlBreakpoint(record)

    const remaining = [...this.breakpoints.values()]
    for (const [scriptId, breakpointId] of record.mappedBreakpointIds) {
      // 这一处还有别的断点共用着：断点留着，换个主人。
      const sharer = remaining.find(
        (other) => other.mappedBreakpointIds.get(scriptId) === breakpointId
      )
      if (sharer) {
        this.breakpointsById.set(breakpointId, sharer)
        continue
      }
      for (const [locationKey, id] of this.mappedBreakpointLocations) {
        if (id === breakpointId) this.mappedBreakpointLocations.delete(locationKey)
      }
      await this.removeInspectorBreakpoint(breakpointId)
    }
    record.mappedBreakpointIds.clear()
    record.resolvedLines.clear()

    const path = record.absolutePath
    if (path && !remaining.some((other) => other.absolutePath === path))
      await this.removeEntryBreakpoint(path)
  }

  private async removeUrlBreakpoint(record: BreakpointRecord): Promise<void> {
    const breakpointId = record.urlBreakpointId
    if (!breakpointId) return
    record.urlBreakpointId = null
    record.resolvedLines.delete(breakpointId)
    await this.removeInspectorBreakpoint(breakpointId)
  }

  private async removeEntryBreakpoint(path: string): Promise<void> {
    const breakpointId = this.entryBreakpointIds.get(path)
    if (!breakpointId) return
    this.entryBreakpointIds.delete(path)
    this.entryBreakpointPaths.delete(breakpointId)
    await this.removeInspectorBreakpoint(breakpointId)
  }

  private async removeInspectorBreakpoint(breakpointId: string): Promise<void> {
    this.breakpointsById.delete(breakpointId)
    this.mappedBreakpointActualLocations.delete(breakpointId)
    await this.connection
      ?.send('Debugger.removeBreakpoint', { breakpointId })
      .catch(() => undefined)
  }

  private handleBreakpointResolved(params: Record<string, unknown>): void {
    const breakpointId = String(params.breakpointId)
    const record = this.breakpointsById.get(breakpointId)
    const location = params.location as InspectorLocation | undefined
    // 只有按地址下的断点会事后才落到代码上；已经被摘掉的（就地转换的文件）不算。
    if (!record || !location || record.urlBreakpointId !== breakpointId) return

    // 同一个文件被加载了几次（几个上下文里各一份）时取最靠前的那一行。
    const previous = record.resolvedLines.get(breakpointId)
    const line = location.lineNumber + 1
    record.resolvedLines.set(breakpointId, previous === undefined ? line : Math.min(previous, line))
    this.emitBreakpointStatus()
  }

  private breakpointStatuses(): WorkbenchDebuggerBreakpointStatus[] {
    return [...this.breakpoints.values()].map((record) => {
      const lines = [...record.resolvedLines.values()]
      return {
        path: record.path,
        line: record.line,
        verified: lines.length > 0,
        resolvedLine: lines.length > 0 ? Math.min(...lines) : null,
      }
    })
  }

  private emitBreakpointStatus(force = false): void {
    const breakpoints = this.breakpointStatuses()
    const serialized = JSON.stringify(breakpoints)
    if (!force && serialized === this.lastBreakpointStatus) return
    this.lastBreakpointStatus = serialized
    this.emit({ type: 'breakpoints', sessionId: this.sessionId, breakpoints })
  }

  // ── 暂停与继续 ──────────────────────────────────────────────────────────────

  private async handlePaused(params: Record<string, unknown>): Promise<void> {
    const connection = this.requireConnection()
    const frames = (params.callFrames as InspectorCallFrame[] | undefined) ?? []
    const hitIds = ((params.hitBreakpoints as string[] | undefined) ?? []).map(String)
    const reasons =
      params.reason === 'ambiguous'
        ? (((params.data as { reasons?: Array<{ reason?: string }> } | undefined)?.reasons ?? [])
            .map((item) => item.reason ?? 'other'))
        : [String(params.reason)]

    // 入口断点停一次就够了：此刻这个文件的脚本已经解析过、映射的断点也下好了（事件是按顺序处理的）。
    const hitEntry = hitIds.some((id) => this.knownEntryBreakpointIds.has(id))
    for (const id of hitIds) {
      const path = this.entryBreakpointPaths.get(id)
      if (path) await this.removeEntryBreakpoint(path)
    }

    const requested = this.requestedPause
    this.requestedPause = null
    const hitUser = hitIds.some((id) => this.breakpointsById.has(id))
    const top = frames[0]?.location ?? null
    // 用户按的「暂停」落在 Node 自己的代码里（定时器、事件分发）：那里没什么可看的。接着走——单步不会停在
    // Node 内部——到下一句程序自己的代码再停，仍然算这次暂停。
    if (requested === 'pause' && !hitUser && top && this.isNodeInternalScript(top.scriptId)) {
      this.requestedPause = 'pause'
      await connection.send('Debugger.stepInto')
      return
    }
    const reason = this.classifyPause({ reasons, requested, hitEntry, hitUser, top })
    if (!reason) {
      await connection.send('Debugger.resume')
      return
    }

    this.paused = true
    this.emit({
      type: 'paused',
      sessionId: this.sessionId,
      reason,
      frames: frames
        // 转换器包在用户代码外面的那层函数（tsx 给 CommonJS 包的一层）：源码里没有它，不放进调用栈。
        // 最里层那一帧总是留着——程序就停在那里。
        .filter((frame, index) => index === 0 || !this.isTransformGlue(frame.location))
        .slice(0, MaxFrames)
        .map((frame) => this.toFrame(frame)),
      exception:
        reason === 'exception' && params.data
          ? toWorkbenchDebuggerValue(params.data as InspectorRemoteObject)
          : null,
    })
  }

  /** 这次停下要不要给用户看、算什么原因；不给用户看（调试器自己要的停顿）返回 null。 */
  private classifyPause(pause: {
    reasons: string[]
    requested: Nullable<'pause' | 'step'>
    hitEntry: boolean
    hitUser: boolean
    top: Nullable<InspectorLocation>
  }): Nullable<WorkbenchDebuggerPauseReason> {
    if (pause.hitUser) return 'breakpoint'
    if (pause.reasons.some((reason) => reason === 'exception' || reason === 'promiseRejection'))
      return 'exception'
    if (pause.requested) return pause.requested

    const internal = pause.reasons.every(
      (reason) =>
        reason === 'Break on start' ||
        reason === 'instrumentation' ||
        (reason === 'other' && pause.hitEntry)
    )
    if (internal) {
      // 启动即停、入口断点停下的这一处，正好是刚按映射下的用户断点所在：放行之后 V8 不会再为它停一次，
      // 这一次就算它的。「带 source map 的脚本执行前」那次停顿在脚本开始之前，放行之后断点自己会停。
      const consumesBreakpoint = pause.hitEntry || pause.reasons.includes('Break on start')
      return consumesBreakpoint && pause.top && this.hasBreakpointAt(pause.top) ? 'breakpoint' : null
    }
    // 工具自己在开头停的那一下（Vitest 的 `--inspect-brk`）。
    if (this.skipInitialPause) {
      this.skipInitialPause = false
      return null
    }
    return 'other'
  }

  /**
   * 这个位置是不是就地转换的脚本里、映射不回源码的那部分：脚本地址是用户的源文件，但这一处是转换器自己加的
   * 代码，磁盘上那个文件里没有它。
   */
  private isTransformGlue(location: InspectorLocation): boolean {
    const script = this.scripts.get(location.scriptId)
    if (!script?.sourceMap || !script.path || !script.sourceMap.hasSource(script.path)) return false

    return !script.sourceMap.originalPositionFor({
      line: location.lineNumber,
      column: location.columnNumber ?? 0,
    })
  }

  /** 这个脚本是不是 Node 自己的内部代码（与 `NodeInternalScriptPattern` 同一条规矩）。 */
  private isNodeInternalScript(scriptId: string): boolean {
    return this.scripts.get(scriptId)?.url.startsWith('node:') === true
  }

  /** 有没有哪个按映射下的断点正好落在生成代码的这一处（同一个脚本、同一行同一列）。 */
  private hasBreakpointAt(location: InspectorLocation): boolean {
    const key = locationKeyOf(location)
    for (const actual of this.mappedBreakpointActualLocations.values()) {
      if (actual === key) return true
    }
    return false
  }

  private handleResumed(): void {
    // 继续跑了：上一次停下时拿到的对象都放掉。
    void this.connection
      ?.send('Runtime.releaseObjectGroup', { objectGroup: ObjectGroup })
      .catch(() => undefined)
    if (!this.paused) return
    this.paused = false
    this.emit({ type: 'resumed', sessionId: this.sessionId })
  }

  private toFrame(frame: InspectorCallFrame): WorkbenchDebuggerFrame {
    const scopes: WorkbenchDebuggerScope[] = frame.scopeChain.flatMap((scope) =>
      scope.object.objectId && ScopeTypes.has(scope.type as WorkbenchDebuggerScopeType)
        ? [
            {
              type: scope.type as WorkbenchDebuggerScopeType,
              name: scope.name ?? null,
              objectId: scope.object.objectId,
            },
          ]
        : []
    )
    return {
      id: frame.callFrameId,
      functionName: frame.functionName,
      location: this.toLocation(frame.location),
      scopes,
    }
  }

  /** 生成代码里的位置换成给用户看的位置：有映射的换回源码，没有的就是脚本自己。 */
  private toLocation(location: InspectorLocation): WorkbenchDebuggerLocation {
    const script = this.scripts.get(location.scriptId)
    const column = location.columnNumber ?? 0
    const original = script?.sourceMap?.originalPositionFor({ line: location.lineNumber, column })
    const absolutePath = original?.path ?? script?.path ?? null
    // 转换器自己加的代码：行号是生成代码的，对不上磁盘上的源文件，不给界面去打开。
    const relativePath =
      absolutePath && !(original === null && this.isTransformGlue(location))
        ? getRelativePathInsideRoot(this.options.projectRoot, absolutePath)
        : null
    return {
      path: relativePath && relativePath !== '.' ? toPortableRelativePath(relativePath) : null,
      source: absolutePath ?? script?.url ?? '',
      line: (original?.line ?? location.lineNumber) + 1,
      column: (original?.column ?? column) + 1,
    }
  }
}

interface InspectorException {
  text?: string
  exception?: InspectorRemoteObject
}

function describeException(details: InspectorException): string {
  const description = details.exception?.description
  // 错误对象的描述带着整段调用栈：只要第一行。
  return (description ?? details.text ?? 'Error').split('\n', 1)[0]!
}

function locationKeyOf(location: InspectorLocation): string {
  return `${location.scriptId}:${location.lineNumber}:${location.columnNumber ?? 0}`
}

function breakpointKey(breakpoint: WorkbenchDebuggerBreakpoint): string {
  return `${breakpoint.path}\0${breakpoint.line}`
}

/**
 * 读脚本的 source map：内联的直接解，写着文件路径的从脚本旁边读。读不了、太大、格式不认都给 null（断点按
 * 没有映射处理）；网址不去取。
 */
async function loadSourceMap(
  sourceMapUrl: string,
  scriptPath: string
): Promise<Nullable<WorkbenchSourceMap>> {
  const directory = dirname(scriptPath)
  const inline = decodeInlineSourceMap(sourceMapUrl)
  if (inline !== null) return WorkbenchSourceMap.parse(inline, directory)
  if (/^[a-z][a-z\d+.-]+:/iu.test(sourceMapUrl) && !sourceMapUrl.startsWith('file://')) return null

  try {
    const mapPath = sourceMapUrl.startsWith('file://')
      ? fileURLToPath(sourceMapUrl)
      : resolve(directory, decodeURIComponent(sourceMapUrl))
    const content = await readFile(mapPath)
    if (content.byteLength > MaxSourceMapBytes) return null
    return WorkbenchSourceMap.parse(content.toString('utf8'), dirname(mapPath))
  } catch {
    // arch-guard:silent-catch-ok 映射文件不在（只发了 JS 没发 .map）或读不了：按没有映射处理。
    return null
  }
}
