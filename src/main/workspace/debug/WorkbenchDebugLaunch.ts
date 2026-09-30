/**
 * 起一个带检查器的 Node 程序：挑端口、拼命令行、等检查器就绪。
 *
 * 被调试的程序跑在一个终端会话里（界面上是一张运行卡）：输出、按键、尺寸、结束整棵进程树都沿用终端那一套，
 * 程序拿到的是真终端。检查器只听 127.0.0.1 上的一个端口；端口先向操作系统要一个空闲的，再写进
 * `--inspect-brk=127.0.0.1:端口`。测试里把「起进程」换成直接起子进程（node-pty 在 bun 下收不到数据）。
 */
import { readFile, stat } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { currentPlatform as systemPlatformCompatibility } from '@velaros-ai/core/platform'

import type { WorkbenchTerminalOutputEvent } from '@shared/contracts'

import type { WorkbenchDebuggerLaunchTarget } from '../../../shared/workbenchDebugger'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import type { PathResolver } from '../PathResolver'
import type { TerminalSessions } from '../terminal/TerminalSessions'

/** 检查器只听本机回环地址：别的机器连不上来。 */
export const WorkbenchInspectorHost = '127.0.0.1'
const InspectorPollIntervalMs = 80
const InspectorRequestTimeoutMs = 1_000
const PackageNamePattern = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u

export interface WorkbenchDebugProcessExit {
  exitCode: Nullable<number>
}

/** 一个已经起来的被调试程序。 */
export interface WorkbenchDebugProcess {
  /** 承载它的终端会话（运行卡）。 */
  terminalSessionId: string
  shell: string
  /** 实际的工作目录（绝对路径）。 */
  cwd: string
  /** 程序退出时调一次；已经退出了就立刻调。 */
  onExit(listener: (exit: WorkbenchDebugProcessExit) => void): void
  /** 结束整棵进程树，等它真的退出（或强杀之后再等一会儿）。 */
  stop(): Promise<void>
}

export interface WorkbenchDebugLaunchOptions {
  projectRoot: string
  /** 工作目录：项目里的路径（相对项目根，或者它的绝对路径）。 */
  cwd: string
  command: string
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
    const started = await terminal.startTerminalSession(
      {
        projectRoot: options.projectRoot,
        cwd: options.cwd,
        initialCommand: options.command,
        env: options.env,
        cols: options.cols,
        rows: options.rows,
      },
      (event) => {
        options.onOutput(event)
        if (!event.closed || exit) return
        exit = { exitCode: event.exitCode ?? null }
        for (const listener of exitListeners.splice(0)) listener(exit)
      },
      options.ownerId
    )

    return {
      terminalSessionId: started.sessionId,
      shell: started.shell,
      cwd: started.cwd,
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
      { host: WorkbenchInspectorHost, port, path: '/json/list', timeout: InspectorRequestTimeoutMs },
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

/**
 * 依赖包里的可执行入口：从 `startDirectory` 起一层层往上找 `node_modules/<包>/package.json`，读它的 `bin`。
 * 包可能装在项目根之上（monorepo 把依赖提到了上层），所以不以项目根为界；找不到返回 null。
 */
export async function resolveWorkbenchPackageBin(
  startDirectory: string,
  packageName: string,
  binName: string
): Promise<Nullable<string>> {
  if (!PackageNamePattern.test(packageName)) return null

  for (let directory = startDirectory; ; directory = dirname(directory)) {
    const packageDirectory = join(directory, 'node_modules', packageName)
    const manifest = await readFile(join(packageDirectory, 'package.json'), 'utf8').catch(() => null)
    if (manifest !== null) {
      try {
        const { bin } = JSON.parse(manifest) as { bin?: unknown }
        const entry =
          typeof bin === 'string' ? bin : (bin as Record<string, unknown> | undefined)?.[binName]
        if (typeof entry !== 'string') return null

        const binPath = resolve(packageDirectory, entry)
        // 入口得在包自己的目录里：清单里写着 `../../x` 的不认。
        if (relative(packageDirectory, binPath).startsWith('..')) return null
        return (await stat(binPath)).isFile() ? binPath : null
      } catch {
        // arch-guard:silent-catch-ok 清单坏了或入口文件不在：这个包起不来，按没找到处理。
        return null
      }
    }
    if (dirname(directory) === directory) return null
  }
}

function quoteArgument(value: string): string {
  return systemPlatformCompatibility.quoteShellArg(value, { env: process.env })
}

/** 脚本在命令行里怎么写：在工作目录里的写相对路径（短，也好认），否则写绝对路径。 */
function displayScriptPath(scriptPath: string, cwd: string): string {
  const relativePath = relative(cwd, scriptPath)
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
    ? relativePath
    : scriptPath
}

/**
 * 拼出带检查器开关的命令行（交给 shell 执行）。`cwd` 是工作目录的真实绝对路径。脚本不在项目里、不是文件，
 * 或者找不到依赖包的入口，都在这里报错——程序还没起。
 */
export async function buildWorkbenchDebugCommand(
  target: WorkbenchDebuggerLaunchTarget,
  context: { projectRoot: string; cwd: string; port: number; pathResolver: PathResolver }
): Promise<string> {
  const inspect = `--inspect-brk=${WorkbenchInspectorHost}:${context.port}`
  if (target.kind === 'inspect-command') {
    const command = target.command.trim()
    if (!command) throw new AppError('VALIDATION', workbenchMainText('commands.empty'))
    return `${command} ${inspect}`
  }

  let program: string
  if (target.kind === 'node-script') {
    const script = await context.pathResolver.resolveInsideProject(context.projectRoot, target.script)
    if (!(await stat(script.realPath)).isFile())
      throw new AppError('VALIDATION', workbenchMainText('debug.scriptNotFile', { path: target.script }))
    program = displayScriptPath(script.realPath, context.cwd)
  } else {
    const binName = target.binName ?? target.packageName
    const bin = await resolveWorkbenchPackageBin(context.cwd, target.packageName, binName)
    if (!bin)
      throw new AppError(
        'NOT_FOUND',
        workbenchMainText('debug.packageBinMissing', { package: target.packageName })
      )
    program = displayScriptPath(bin, context.cwd)
  }

  const args = target.args?.trim()
  return ['node', inspect, quoteArgument(program), ...(args ? [args] : [])].join(' ')
}
