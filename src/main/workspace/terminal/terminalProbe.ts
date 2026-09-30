/**
 * 终端探针：用真正的伪终端起 shell，验证输出回传、输入回显、中文、尺寸、停止与所有权隔离。
 * 经 `scripts/probe/runTerminalProbe.mjs` 在 Electron 运行时里跑（node-pty 在 bun 下收不到数据）。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandHelper } from '../CommandHelper'
import { PathResolver } from '../PathResolver'

import { buildTerminalEnvironment, clampTerminalDimension, TerminalSessions } from './TerminalSessions'

let assertionCount = 0

function check(value: unknown, message: string): asserts value {
  assert.ok(value, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // arch-guard:silent-catch-ok ESRCH：进程已经不在了。
    return false
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assertionCount += 1
}

const environment = buildTerminalEnvironment({ PATH: '/usr/bin' }, 'darwin')
equal(environment.TERM, 'xterm-256color', '终端必须自称 xterm-256color')
equal(environment.LANG, 'en_US.UTF-8', '没有 locale 时必须补 UTF-8，否则中文进不了 shell')
equal(buildTerminalEnvironment({ LANG: 'zh_CN.UTF-8' }, 'darwin').LANG, 'zh_CN.UTF-8', '用户自己的 locale 优先')
equal(clampTerminalDimension(undefined, 80, 1000), 80, '没给尺寸用默认值')
equal(clampTerminalDimension(0, 80, 1000), 1, '尺寸至少 1')
equal(clampTerminalDimension(5000, 24, 500), 500, '尺寸不超过上限')

const projectRoot = mkdtempSync(join(tmpdir(), 'velaros-workbench-terminal-probe-'))
const pathResolver = new PathResolver()
const terminal = new TerminalSessions(pathResolver, new CommandHelper())

try {
  await assert.rejects(
    terminal.startTerminalSession({ projectRoot, cwd: '..' }, () => undefined),
    /超出工程范围/,
    '终端 cwd 越界必须拒绝'
  )
  assertionCount += 1

  // 一次性命令（运行卡）：命令退出即收口。
  let commandOutput = ''
  let commandClosed = false
  const command = await terminal.startTerminalSession(
    { projectRoot, initialCommand: "printf 'VELAROS_TERMINAL_PROBE_OK\\n'" },
    (event) => {
      commandOutput += event.chunk
      if (event.closed) commandClosed = true
    }
  )
  check(command.sessionId.startsWith('terminal-'), '终端会话必须返回独立持久句柄')
  equal(
    command.projectRoot,
    await pathResolver.resolveProjectRoot(projectRoot),
    '终端会话必须绑定 canonical 项目根'
  )
  await waitFor(() => commandClosed, '一次性命令必须在 8 秒内退出并收口')
  check(commandOutput.includes('VELAROS_TERMINAL_PROBE_OK'), '命令输出必须回传给 renderer 订阅面')
  check(commandOutput.includes('进程已结束'), '收口事件必须带宿主提示')

  // 交互 shell：真终端有回显；中文原样进出；尺寸可调；Ctrl+C 只打断不退出。
  let shellOutput = ''
  let shellClosed = false
  const shell = await terminal.startTerminalSession(
    { projectRoot, cols: 120, rows: 40 },
    (event) => {
      shellOutput += event.chunk
      if (event.closed) shellClosed = true
    },
    101
  )
  terminal.writeTerminalInput({ sessionId: shell.sessionId, input: 'echo 探针_中文_OK\r' }, 101)
  await waitFor(() => shellOutput.split('探针_中文_OK').length >= 3, '交互 shell 必须回显输入并打印中文结果')
  // 拆分出来的终端从原来那个 shell 此刻所在的目录开始（问操作系统，Windows 上问不到）。
  if (process.platform !== 'win32') {
    terminal.writeTerminalInput(
      { sessionId: shell.sessionId, input: 'mkdir -p 子目录 && cd 子目录 && echo CD_DONE_$((40+2))\r' },
      101
    )
    await waitFor(() => shellOutput.includes('CD_DONE_42'), '交互 shell 必须完成 cd')
    const split = await terminal.startTerminalSession(
      { projectRoot, inheritCwdFrom: shell.sessionId },
      () => undefined,
      101
    )
    equal(
      split.cwd,
      join(await pathResolver.resolveProjectRoot(projectRoot), '子目录'),
      '拆分出来的终端必须从原 shell 所在的目录开始'
    )
  }
  terminal.resizeTerminalSession({ sessionId: shell.sessionId, cols: 60, rows: 20 }, 101)
  await terminal.stopTerminalSession({ sessionId: shell.sessionId, signal: 'SIGINT' }, 101)
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(!shellClosed, 'Ctrl+C 只打断前台程序，shell 会话不能结束')

  // 停止运行卡要连它放到后台的任务一起结束：nohup 忽略伪终端关闭时的 SIGHUP，只有整棵进程树都收到信号才会退。
  if (process.platform !== 'win32') {
    const marker = `VELAROS_TERMINAL_PROBE_BG_${process.pid}`
    let backgroundOutput = ''
    const background = await terminal.startTerminalSession(
      { projectRoot, initialCommand: `nohup sleep 300 >/dev/null 2>&1 & echo ${marker} $!; wait` },
      (event) => {
        backgroundOutput += event.chunk
      },
      303
    )
    await waitFor(() => new RegExp(`${marker} \\d+`).test(backgroundOutput), '运行卡必须打印后台任务的 pid')
    const sleepPid = Number(new RegExp(`${marker} (\\d+)`).exec(backgroundOutput)?.[1])
    check(isProcessAlive(sleepPid), '后台任务在停止前必须还活着')
    await terminal.stopTerminalSession({ sessionId: background.sessionId, waitForExit: true }, 303)
    await waitFor(() => !isProcessAlive(sleepPid), '停止运行卡必须连它放到后台的任务一起结束')
  }

  const other = await terminal.startTerminalSession({ projectRoot }, () => undefined, 202)
  assert.throws(
    () => terminal.writeTerminalInput({ sessionId: shell.sessionId, input: 'echo denied\r' }, 202),
    /不属于当前项目窗口/,
    '其他项目窗口不得写入不属于它的终端'
  )
  assertionCount += 1

  await terminal.closeSessionsForOwner(101)
  await waitFor(() => shellClosed, '退出项目必须关闭该窗口拥有的终端')
  assert.throws(
    () => terminal.writeTerminalInput({ sessionId: shell.sessionId, input: 'echo closed\r' }, 101),
    /已结束/,
    '已关闭的终端不能再写'
  )
  assertionCount += 1
  terminal.writeTerminalInput({ sessionId: other.sessionId, input: 'exit\r' }, 202)
  await terminal.closeAllSessions()
} finally {
  await terminal.closeAllSessions()
  rmSync(projectRoot, { recursive: true, force: true })
}

console.info(`terminal probe passed (${assertionCount} assertions)`)
