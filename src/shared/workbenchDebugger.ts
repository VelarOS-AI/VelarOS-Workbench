/**
 * Node.js 调试器的 main ↔ renderer 契约（应用私有）。
 *
 * 主进程起一个带检查器的 Node 程序（`--inspect-brk`，只听 127.0.0.1），经 Chrome DevTools 协议连上去；renderer
 * 只见这里的形状：断点（文件 + 行号）、暂停时的调用栈与变量、单步与求值。被调试的程序跑在一个终端会话里，
 * 界面上就是一张运行卡，它的输出走终端那条通道。
 *
 * 行号、列号在这里都从 1 起，与编辑器一致。错误信封复用 `WorkbenchFsCallResult`。
 */
import type {
  WorkbenchNodePackageBinTarget,
  WorkbenchNodeScriptTarget,
  WorkbenchPackageManagerTarget,
} from './contracts/workbench'
import type { WorkbenchFsCallResult } from './workbenchFs'

export const WorkbenchDebuggerChannels = {
  start: 'workbench-app:debugger:start',
  stop: 'workbench-app:debugger:stop',
  control: 'workbench-app:debugger:control',
  setBreakpoints: 'workbench-app:debugger:set-breakpoints',
  setExceptionPause: 'workbench-app:debugger:set-exception-pause',
  variables: 'workbench-app:debugger:variables',
  evaluate: 'workbench-app:debugger:evaluate',
  /** main → renderer：会话的状态变化，只推给发起它的窗口。 */
  event: 'workbench-app:debugger:event',
} as const

/** 一个断点：项目里的文件（相对路径，`/` 分隔）和行号。 */
export interface WorkbenchDebuggerBreakpoint {
  path: string
  line: number
}

export interface WorkbenchDebuggerBreakpointStatus extends WorkbenchDebuggerBreakpoint {
  /** 正在跑的程序里这一行对得上代码。程序没加载这个文件、或者这一行之后再没有代码，就对不上。 */
  verified: boolean
  /** 实际会停在哪一行（这一行没有可执行的代码时顺延到后面最近的一行）；没对上为 null。 */
  resolvedLine: Nullable<number>
}

/**
 * 调试目标的启动方式：
 * - `node-script`：项目里的一个脚本，`node --inspect-brk=… <脚本> <参数>`；
 * - `node-package-bin`：依赖包里的可执行入口（从工作目录起往上找 `node_modules/<包>`），同样由 node 直接带着
 *   检查器起——Jest 这类自己不认检查器开关的工具；
 * - `inspect-process`：自己识别检查器参数的运行器（Vitest），开关作为独立 argv 追加；
 * - `inspect-command`：用户填写、自己识别 `--inspect-brk=主机:端口` 的 shell 命令，开关追加在命令末尾。这类工具
 *   连上之后会自己先停一下，那一下不算数，直接放行。
 *
 * `argv` 逐项传递，不经过 shell；`args` 与 `command` 是用户填写的 shell 原文，不拆分重建。
 */
export type WorkbenchDebuggerLaunchTarget =
  | WorkbenchNodeScriptTarget
  | WorkbenchNodePackageBinTarget
  | { kind: 'inspect-process'; process: WorkbenchPackageManagerTarget }
  | { kind: 'inspect-command'; command: string }

export interface WorkbenchDebuggerStartRequest {
  projectRoot: string
  target: WorkbenchDebuggerLaunchTarget
  /** 工作目录：项目里的相对路径，不给就是项目根。 */
  cwd?: string
  /** 额外的环境变量，规则同运行卡（见 `workbenchRunEnvironment.ts`）。 */
  env?: Record<string, string>
  breakpoints: WorkbenchDebuggerBreakpoint[]
  pauseOnUncaughtExceptions: boolean
  /** 运行卡的初始尺寸（字符格）。 */
  cols?: number
  rows?: number
}

export interface WorkbenchDebuggerStartResult {
  sessionId: string
  /** 承载被调试程序的终端会话：界面把它画成一张运行卡，输出、尺寸、按键都走终端那一套。 */
  terminalSessionId: string
  /** 实际执行的命令行（带着检查器开关）。 */
  command: string
  cwd: string
  shell: string
}

export type WorkbenchDebuggerControlAction =
  | 'continue'
  | 'pause'
  | 'step-into'
  | 'step-out'
  | 'step-over'

export interface WorkbenchDebuggerLocation {
  /** 项目里的文件：相对路径；项目之外的（依赖包之外的绝对路径、Node 内部）为 null，界面不去打开。 */
  path: Nullable<string>
  /** 给人看的出处：文件的绝对路径，或者脚本自己的名字（`node:internal/…`）。 */
  source: string
  line: number
  column: number
}

export type WorkbenchDebuggerScopeType =
  | 'block'
  | 'catch'
  | 'closure'
  | 'eval'
  | 'global'
  | 'local'
  | 'module'
  | 'script'
  | 'with'

export interface WorkbenchDebuggerScope {
  type: WorkbenchDebuggerScopeType
  /** 闭包所属的函数名等；没有为 null。 */
  name: Nullable<string>
  /** 交给 `variables` 取这个作用域里的变量。 */
  objectId: string
}

export interface WorkbenchDebuggerFrame {
  id: string
  /** 匿名函数是空串。 */
  functionName: string
  location: WorkbenchDebuggerLocation
  scopes: WorkbenchDebuggerScope[]
}

/**
 * 值的种类：`typeof` 的那几种加上 null，另有两种没有值可给的——`accessor` 是只有 getter / setter 的属性
 * （不替用户去调它），`unavailable` 是还没初始化的 `let` / `const`。
 */
export type WorkbenchDebuggerValueType =
  | 'accessor'
  | 'bigint'
  | 'boolean'
  | 'function'
  | 'null'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'unavailable'
  | 'undefined'

export interface WorkbenchDebuggerValue {
  type: WorkbenchDebuggerValueType
  /** 给人看的一行文字：字符串带引号，对象是简短的预览。`accessor`、`unavailable` 没有值，是空串。 */
  text: string
  /** 能展开的对象才有：交给 `variables` 取它的属性。 */
  objectId: Nullable<string>
}

export interface WorkbenchDebuggerVariable {
  name: string
  value: WorkbenchDebuggerValue
}

/** 为什么停下：断点、异常、用户点了暂停、单步走完；其余（`debugger` 语句等）归 `other`。 */
export type WorkbenchDebuggerPauseReason = 'breakpoint' | 'exception' | 'other' | 'pause' | 'step'

/** 会话怎么结束的：程序退出了、用户停掉的、根本没连上。 */
export type WorkbenchDebuggerEndReason = 'exited' | 'failed' | 'stopped'

export type WorkbenchDebuggerEvent =
  /** 连上了检查器，程序开始跑。 */
  | { type: 'attached'; sessionId: string }
  | {
      type: 'paused'
      sessionId: string
      reason: WorkbenchDebuggerPauseReason
      /** 调用栈，最里层在前。 */
      frames: WorkbenchDebuggerFrame[]
      /** 停在异常上时：抛出来的值。 */
      exception: Nullable<WorkbenchDebuggerValue>
    }
  | { type: 'resumed'; sessionId: string }
  /** 各个断点对没对上代码（设了之后、程序加载了新文件之后都会变）。 */
  | { type: 'breakpoints'; sessionId: string; breakpoints: WorkbenchDebuggerBreakpointStatus[] }
  | {
      type: 'ended'
      sessionId: string
      reason: WorkbenchDebuggerEndReason
      exitCode: Nullable<number>
      /** `failed` 时的原因。 */
      message: Nullable<string>
    }

export interface WorkbenchDebuggerSessionRequest {
  sessionId: string
}

export interface WorkbenchDebuggerControlRequest extends WorkbenchDebuggerSessionRequest {
  action: WorkbenchDebuggerControlAction
}

/** 整份换掉会话里的断点（主进程自己算增删）。 */
export interface WorkbenchDebuggerSetBreakpointsRequest extends WorkbenchDebuggerSessionRequest {
  breakpoints: WorkbenchDebuggerBreakpoint[]
}

export interface WorkbenchDebuggerSetBreakpointsResult {
  breakpoints: WorkbenchDebuggerBreakpointStatus[]
}

export interface WorkbenchDebuggerExceptionPauseRequest extends WorkbenchDebuggerSessionRequest {
  /** 在没人接住的异常上停下。 */
  uncaught: boolean
}

export interface WorkbenchDebuggerVariablesRequest extends WorkbenchDebuggerSessionRequest {
  objectId: string
}

export interface WorkbenchDebuggerVariablesResult {
  variables: WorkbenchDebuggerVariable[]
  /** 属性太多，只给了前面一部分。 */
  truncated: boolean
}

export interface WorkbenchDebuggerEvaluateRequest extends WorkbenchDebuggerSessionRequest {
  expression: string
  /** 在哪一帧里求值；不给就在全局求值。 */
  frameId?: string
  /** 只看不动：表达式有副作用（调函数、赋值）就不求值，当作失败。悬停看变量用。 */
  sideEffectFree?: boolean
}

export interface WorkbenchDebuggerEvaluateResult {
  /** 求出来的值；表达式抛了异常（或被副作用检查挡下）为 null，原因在 `error`。 */
  value: Nullable<WorkbenchDebuggerValue>
  error: Nullable<string>
}

/** preload 通过 contextBridge 暴露给 renderer 的调试器桥面。 */
export interface WorkbenchDebuggerBridge {
  start: (
    request: WorkbenchDebuggerStartRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchDebuggerStartResult>>
  stop: (request: WorkbenchDebuggerSessionRequest) => Promise<WorkbenchFsCallResult<void>>
  control: (request: WorkbenchDebuggerControlRequest) => Promise<WorkbenchFsCallResult<void>>
  setBreakpoints: (
    request: WorkbenchDebuggerSetBreakpointsRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchDebuggerSetBreakpointsResult>>
  setExceptionPause: (
    request: WorkbenchDebuggerExceptionPauseRequest
  ) => Promise<WorkbenchFsCallResult<void>>
  getVariables: (
    request: WorkbenchDebuggerVariablesRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchDebuggerVariablesResult>>
  evaluate: (
    request: WorkbenchDebuggerEvaluateRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchDebuggerEvaluateResult>>
  onEvent: (listener: (event: WorkbenchDebuggerEvent) => void) => () => void
}
