/**
 * 准备调试进程、取得本机检查器端口并等待连接。
 *
 * 被调试的程序跑在一个终端会话里（界面上是一张运行卡）：输出、按键、尺寸、结束整棵进程树都沿用终端那一套，
 * 程序拿到的是真终端。检查器只听 127.0.0.1 上的一个端口；端口先向操作系统要一个空闲的，再写进
 * `--inspect-brk=127.0.0.1:端口`。测试里把「起进程」换成直接起子进程（node-pty 在 bun 下收不到数据）。
 */
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'

import { AppError } from '@velaros-ai/velaros/core/error'
import { currentPlatform as systemPlatformCompatibility } from '@velaros-ai/velaros/core/platform'

import { type WorkbenchTerminalOutputEvent } from '@shared/contracts/workbench'

import type { WorkbenchDebuggerLaunchTarget } from '../../../shared/workbenchDebugger'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import type { TerminalSessions } from '../terminal/TerminalSessions'
import {
  resolveWorkbenchProcessLaunch,
  type WorkbenchProcessContext,
  type WorkbenchResolvedProcess,
} from '../WorkbenchProcessLaunch'

/** 检查器只听本机回环地址：别的机器连不上来。 */
export const WorkbenchInspectorHost = '127.0.0.1'
const InspectorPollIntervalMs = 80
const InspectorRequestTimeoutMs = 1_000

export interface WorkbenchDebugProcessExit {
  exitCode: Nullable<number>
}

/** 一个已经起来的被调试程序。 */
export interface WorkbenchDebugProcess {
  /** 承载它的终端会话（运行卡）。 */
  terminalSessionId: string
  projectRoot: string
  shell: string
  /** 实际的工作目录（绝对路径）。 */
  cwd: string
  /** 实际启动计划的展示文本，不参与后续执行。 */
  command: string
  /** 运行器自行发起的首个暂停不展示给用户。 */
  skipInitialPause: boolean
  /** 程序退出时调一次；已经退出了就立刻调。 */
  onExit(listener: (exit: WorkbenchDebugProcessExit) => void): void
  /** 结束整棵进程树，等它真的退出（或强杀之后再等一会儿）。 */
  stop(): Promise<void>
}

export interface WorkbenchDebugLaunchOptions {
  projectRoot: string
  /** 工作目录：项目里的路径（相对项目根，或者它的绝对路径）。 */
  cwd: string
  target: WorkbenchDebuggerLaunchTarget
  port: number
  signal: AbortSignal
  env?: Record<string, string>
  cols?: number
  rows?: number
  ownerId: Nullable<number>
  /** 程序的输出（终端事件）送给谁：发起调试的那个窗口。 */
  onOutput: (event: WorkbenchTerminalOutputEvent) => void
}

export type WorkbenchDebugLauncher = (
  options: WorkbenchDebugLaunchOptions
) => Promise<WorkbenchDebugProcess>

/** 生产用的起法：在终端会话里跑，归发起的窗口所有，关窗、退出应用时随终端一起结束。 */
export function createTerminalDebugLauncher(terminal: TerminalSessions): WorkbenchDebugLauncher {
  return async (options) => {
    const exitListeners: Array<(exit: WorkbenchDebugProcessExit) => void> = []
    let exit: Nullable<WorkbenchDebugProcessExit> = null
    const context = await terminal.prepareProcessContext(options, options.signal, options.ownerId)
    const plan = await buildWorkbenchDebugLaunchPlan(options.target, context, options.port)
    const started = await terminal.startResolvedProcessSession(
      context,
      plan.process,
      (event) => {
        options.onOutput(event)
        if (!event.closed || exit) return
        exit = { exitCode: event.exitCode ?? null }
        for (const listener of exitListeners.splice(0)) listener(exit)
      },
      options.ownerId,
      { cols: options.cols, rows: options.rows }
    )

    return {
      terminalSessionId: started.sessionId,
      projectRoot: started.projectRoot,
      shell: started.shell,
      cwd: started.cwd,
      command: plan.command,
      skipInitialPause: plan.skipInitialPause,
      onExit: (listener) => {
        if (exit) listener(exit)
        else exitListeners.push(listener)
      },
      stop: () =>
        terminal.stopTerminalSession(
          { sessionId: started.sessionId, waitForExit: true },
          options.ownerId
        ),
    }
  }
}

/** 向操作系统要一个此刻空闲的本机端口。 */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, WorkbenchInspectorHost, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (port > 0) resolvePort(port)
        else reject(new AppError('PLATFORM', 'no free loopback port'))
      })
    })
  })
}

/** 问检查器它的 WebSocket 地址；还没起来（连不上）给 null。 */
function readInspectorEndpoint(port: number): Promise<Nullable<string>> {
  return new Promise((resolveEndpoint) => {
    const request = httpGet(
      {
        host: WorkbenchInspectorHost,
        port,
        path: '/json/list',
        timeout: InspectorRequestTimeoutMs,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => {
          try {
            const targets = JSON.parse(body) as Array<{ id?: unknown }>
            const id = targets[0]?.id
            // 地址自己拼，不用检查器回的那个：只连本机这个端口。
            resolveEndpoint(
              typeof id === 'string' && /^[\w-]+$/u.test(id)
                ? `ws://${WorkbenchInspectorHost}:${port}/${id}`
                : null
            )
          } catch {
            // arch-guard:silent-catch-ok 端口上答话的不是检查器，或者回了半截：当作还没就绪。
            resolveEndpoint(null)
          }
        })
      }
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolveEndpoint(null))
  })
}

/**
 * 等检查器在这个端口上就绪，返回它的 WebSocket 地址。程序已经退出（`isCancelled`）或者等过了头返回 null。
 */
export async function waitForInspectorEndpoint(
  port: number,
  options: { timeoutMs: number; isCancelled: () => boolean }
): Promise<Nullable<string>> {
  const deadline = Date.now() + options.timeoutMs
  while (!options.isCancelled() && Date.now() < deadline) {
    const endpoint = await readInspectorEndpoint(port)
    if (endpoint) return endpoint
    await new Promise((resolveDelay) => setTimeout(resolveDelay, InspectorPollIntervalMs))
  }
  return null
}

export interface WorkbenchDebugLaunchPlan {
  process: WorkbenchResolvedProcess
  command: string
  skipInitialPause: boolean
}

/** 最终 cwd/env 决定实际程序；Node 前缀与运行器参数始终属于各自的参数位置。 */
export async function buildWorkbenchDebugLaunchPlan(
  target: WorkbenchDebuggerLaunchTarget,
  context: WorkbenchProcessContext,
  port: number
): Promise<WorkbenchDebugLaunchPlan> {
  context.signal.throwIfAborted()
  const inspect = `--inspect-brk=${WorkbenchInspectorHost}:${port}`
  if (target.kind === 'inspect-command') {
    if (!target.command.trim() || target.command.includes('\0'))
      throw new AppError('VALIDATION', workbenchMainText('commands.empty'))
    const command = `${target.command} ${inspect}`
    const spec = systemPlatformCompatibility.getShellCommandSpec(command, { env: context.env })
    return {
      process: {
        file: spec.file,
        argv: spec.args,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      },
      command,
      skipInitialPause: true,
    }
  }
  const skipInitialPause = target.kind === 'inspect-process'
  const process = await (target.kind === 'inspect-process'
    ? resolveWorkbenchProcessLaunch(
        { ...target.process, argv: [...target.process.argv, inspect] },
        context
      )
    : resolveWorkbenchProcessLaunch(target, context, { nodeArgvPrefix: [inspect] }))
  context.signal.throwIfAborted()
  return {
    process,
    command: [process.file, ...process.argv]
      .map((argument) => /^[\w./:=@+-]+$/u.test(argument) ? argument : JSON.stringify(argument))
      .join(' '),
    skipInitialPause,
  }
}
