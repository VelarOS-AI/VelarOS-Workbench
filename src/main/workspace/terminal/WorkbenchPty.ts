/**
 * 终端会话用的伪终端（PTY）抽象。
 *
 * 真实实现来自 `@lydell/node-pty`——node-pty 的预编译发行版：每个平台一个包、N-API 二进制不随 Electron 版本
 * 重编译、`spawn-helper` 自带可执行位、没有安装脚本（bun 默认不跑依赖的安装脚本，官方 node-pty 正是靠
 * postinstall 补权限）。原生模块在这里惰性加载：主进程启动不碰它，平台没有二进制时第一次开终端才报错，
 * 编辑器与语言服务不受影响。测试与探针注入自己的工厂。
 */
import { createRequire } from 'node:module'

import { AppError } from '@velaros-ai/core/error'

import { workbenchMainText } from '../../i18n/workbenchMainMessages'

import { readWorkbenchProcessCwd } from './WorkbenchProcessCwd'
import { listWorkbenchProcessTree, signalWorkbenchProcesses } from './WorkbenchProcessTree'

export interface WorkbenchPtyExit {
  exitCode: number
  signal?: number
}

/** 一个已经起来的伪终端；只暴露会话服务用到的那一面。 */
export interface WorkbenchPtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: WorkbenchPtyExit) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /** 暂停 / 继续读伪终端：不读，程序写满缓冲区后就会阻塞在写上（流控）。 */
  pause(): void
  resume(): void
}

export interface WorkbenchPtySpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
  /** 终端类型名（`TERM`）。 */
  name: string
  windowsVerbatimArguments?: boolean
}

/** 伪终端上的整棵进程树：列出来、发信号（真实实现走系统进程表）。 */
export interface WorkbenchProcessTreeOps {
  list(rootPid: number): Promise<number[]>
  signal(pids: readonly number[], signal: NodeJS.Signals): void
}

export interface WorkbenchPtyFactory {
  spawn(file: string, args: string[], options: WorkbenchPtySpawnOptions): WorkbenchPtyProcess
  /** 结束会话时对整棵进程树下手的办法；测试里的假工厂不给，就只对伪终端本身发信号，不会碰到真实进程。 */
  readonly processTree?: WorkbenchProcessTreeOps
  /** 一个进程此刻所在的目录（问操作系统）；问不到给 null，假工厂不给就一律当作问不到。 */
  readonly readCwd?: (pid: number) => Promise<Nullable<string>>
}

type NodePtyModule = typeof import('@lydell/node-pty')

const require = createRequire(import.meta.url)
let nodePty: Nullable<NodePtyModule> = null
let nodePtyLoadError: Nullable<AppError> = null

function loadNodePty(): NodePtyModule {
  if (nodePty) return nodePty
  if (nodePtyLoadError) throw nodePtyLoadError

  try {
    nodePty = require('@lydell/node-pty') as NodePtyModule
    return nodePty
  } catch (error) {
    nodePtyLoadError = new AppError(
      'PLATFORM',
      workbenchMainText('terminal.backendUnavailable', {
        platform: `${process.platform}-${process.arch}`,
        reason: (error as Error).message,
      }),
      error
    )
    throw nodePtyLoadError
  }
}

/** 生产用的工厂：真正的 node-pty。 */
export const nodePtyFactory: WorkbenchPtyFactory = {
  processTree: { list: listWorkbenchProcessTree, signal: signalWorkbenchProcesses },
  readCwd: readWorkbenchProcessCwd,
  spawn: (file, args, options) => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value
    return loadNodePty().spawn(file, options.windowsVerbatimArguments ? args.join(' ') : args, {
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env,
    })
  },
}
