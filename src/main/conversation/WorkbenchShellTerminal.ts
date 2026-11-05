import { createRequire } from 'node:module'

import type * as NodePty from '@lydell/node-pty'

import { isNotUndefined, isUndefined, Log } from '@velaros-ai/velaros/core'
import type { ShellTerminalFactory } from '@velaros-ai/velaros/execution'

import { buildPtyArguments } from '../workspace/terminal/PtyArguments'

const log = Log.tag('WorkbenchShellTerminal')
const require = createRequire(import.meta.url)

/** 载入的结果只算一次：拿到的工厂，null 表示这个平台没有可用的二进制，还没载入时是 undefined。 */
let loaded: LooseOptional<ShellTerminalFactory>

/**
 * Agent 交互式命令的真终端后端（与 Desktop 同一做法，也与 IDE 终端用同一个 `@lydell/node-pty`）：
 * 第一次建 shell 宿主时才载入原生模块；这个平台没有二进制就返回 null，交互式命令退回管道。
 */
export function loadWorkbenchShellTerminal(): Nullable<ShellTerminalFactory> {
  if (isUndefined(loaded)) loaded = createNodePtyTerminal()
  return loaded
}

function createNodePtyTerminal(): Nullable<ShellTerminalFactory> {
  let nodePty: typeof NodePty
  try {
    nodePty = require('@lydell/node-pty') as typeof NodePty
  } catch (error) {
    log.warn('没有可用的终端后端，交互式命令改用管道', {
      target: `${process.platform}-${process.arch}`,
      error,
    })
    return null
  }
  return {
    // 绕开 node-pty 对首尾带引号的整个参数的错误猜测。
    spawn: (file, args, options) =>
      nodePty.spawn(file, buildPtyArguments(args, options.windowsVerbatimArguments), {
        name: options.name,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: definedEnvironment(options.env),
      }),
  }
}

/** node-pty 的环境变量只收字符串，没有值的键去掉。 */
function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (isNotUndefined(value)) defined[key] = value
  return defined
}
