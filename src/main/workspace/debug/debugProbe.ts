/**
 * 调试器探针：被调试的程序跑在真正的伪终端里（与应用里一样，是一张运行卡），验证检查器连得上、断点停得住、
 * 输出走终端那条通道、程序自己跑完时卡片正常收口、结束调试时整棵进程树一起结束、别的窗口碰不了。
 * 经 `scripts/probe/runDebugProbe.mjs` 在 Electron 运行时里跑（node-pty 在 bun 下收不到数据）。
 * 需要 PATH 上有 `node`。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type WorkbenchTerminalOutputEvent } from '@shared/contracts/workbench'

import type {
  WorkbenchDebuggerEvent,
  WorkbenchDebuggerStartRequest,
} from '../../../shared/workbenchDebugger'
import { CommandHelper } from '../CommandHelper'
import { PathResolver } from '../PathResolver'
import { ProbeResourceOwner } from '../terminal/ProbeResourceOwner'
import { TerminalSessions } from '../terminal/TerminalSessions'

import { createTerminalDebugLauncher } from './WorkbenchDebugLaunch'
import { WorkbenchDebugSessions } from './WorkbenchDebugSessions'

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

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  probe.signal.throwIfAborted()
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    probe.signal.throwIfAborted()
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  probe.signal.throwIfAborted()
  assertionCount += 1
}

/** 一次调试：收着它的事件和它那张运行卡的输出。 */
interface ProbeRun {
  sessionId: string
  terminalSessionId: string
  events: WorkbenchDebuggerEvent[]
  output: () => string
  closed: () => Nullable<WorkbenchTerminalOutputEvent>
  paused: () => Array<Extract<WorkbenchDebuggerEvent, { type: 'paused' }>>
  ended: () => LooseOptional<Extract<WorkbenchDebuggerEvent, { type: 'ended' }>>
}

/** 程序打印的 `标记 数字`。 */
function readNumber(output: string, marker: string): number {
  return Number(new RegExp(`${marker} (\\d+)`, 'u').exec(output)?.[1])
}

const probe = new ProbeResourceOwner()
await probe.connect()
const projectRoot = mkdtempSync(join(tmpdir(), 'velaros-workbench-debug-probe-'))
const pathResolver = new PathResolver()
const terminal = new TerminalSessions(pathResolver, new CommandHelper(), probe.ptyFactory)
const debug = new WorkbenchDebugSessions(pathResolver, createTerminalDebugLauncher(terminal))
probe.setCleanup(async () => {
  const errors: unknown[] = []
  try { await debug.closeAllSessions() } catch (error) { errors.push(error) }
  try { await terminal.closeAllSessions() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Debug probe service cleanup failed')
})

async function start(
  request: Omit<WorkbenchDebuggerStartRequest, 'projectRoot' | 'pauseOnUncaughtExceptions'>,
  ownerId: number
): Promise<ProbeRun> {
  const events: WorkbenchDebuggerEvent[] = []
  let output = ''
  let closed: Nullable<WorkbenchTerminalOutputEvent> = null
  const started = await debug.startDebugSession(
    { projectRoot, pauseOnUncaughtExceptions: false, ...request },
    {
      emit: (event) => events.push(event),
      terminalOutput: (event) => {
        output += event.chunk
        if (event.closed) closed = event
      },
    },
    ownerId
  )
  await probe.admitted()
  return {
    sessionId: started.sessionId,
    terminalSessionId: started.terminalSessionId,
    events,
    output: () => output,
    closed: () => closed,
    paused: () => events.filter((event) => event.type === 'paused'),
    ended: () => events.find((event) => event.type === 'ended'),
  }
}

try {
  await probe.registerTemporaryRoot(projectRoot)
  writeFileSync(
    join(projectRoot, 'long.js'),
    [
      "const { spawn } = require('node:child_process')", // 1
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })", // 2
      // 拼成一个字符串再打印：在真终端里 console.log 会给数字上色，夹着转义序列不好认。
      "console.log(`PROBE_PIDS ${process.pid} PROBE_CHILD ${child.pid} PROBE_TTY ${process.stdout.isTTY ? 1 : 0}`)", // 3
      'function work(n) {', // 4
      '  const doubled = n * 2', // 5
      '  return doubled', // 6
      '}', // 7
      "console.log(`PROBE_RESULT ${work(21)}`)", // 8
      'setInterval(() => {}, 1000)', // 9
      '',
    ].join('\n')
  )
  writeFileSync(
    join(projectRoot, 'short.js'),
    ['const label = process.env.PROBE_LABEL', 'console.log(`PROBE_DONE ${label}`)', ''].join('\n')
  )

  // 一个不会自己结束的程序：停在断点上、读变量、继续，然后结束调试。
  const long = await start(
    { target: { kind: 'node-script', script: 'long.js', argv: [] }, breakpoints: [{ path: 'long.js', line: 5 }] },
    101
  )
  check(long.terminalSessionId.startsWith('terminal-'), '被调试的程序必须跑在一个终端会话里（运行卡）')
  await waitFor(() => long.paused().length === 1, '程序必须停在断点上')
  const paused = long.paused()[0]!
  equal(paused.reason, 'breakpoint', '停下的原因必须是断点')
  equal(
    `${paused.frames[0]?.functionName}@${paused.frames[0]?.location.path}:${paused.frames[0]?.location.line}`,
    'work@long.js:5',
    '调用栈最里层必须是断点所在的函数与行'
  )
  const localScope = paused.frames[0]!.scopes.find((scope) => scope.type === 'local')
  check(localScope, '断点所在的帧必须有局部作用域')
  const locals = await debug.getVariables({ sessionId: long.sessionId, objectId: localScope.objectId }, 101)
  equal(locals.variables.find((variable) => variable.name === 'n')?.value.text, '21', '必须读得到局部变量')
  // 终端的输出是攒一小会儿再送的：停下的事件可能先到。
  await waitFor(() => /PROBE_TTY \d/u.test(long.output()), '程序的输出必须走终端那条通道')
  check(/PROBE_TTY 1/u.test(long.output()), '被调试的程序拿到的必须是真终端')
  check(!long.output().includes('PROBE_RESULT'), '停在断点上时后面的代码还没执行')

  await assert.rejects(
    debug.controlDebugSession({ sessionId: long.sessionId, action: 'continue' }, 202),
    /不属于当前项目窗口/u,
    '别的项目窗口不得控制不属于它的调试会话'
  )
  assertionCount += 1

  await debug.controlDebugSession({ sessionId: long.sessionId, action: 'continue' }, 101)
  await waitFor(() => long.output().includes('PROBE_RESULT 42'), '继续之后程序必须接着跑')
  const programPid = readNumber(long.output(), 'PROBE_PIDS')
  const childPid = readNumber(long.output(), 'PROBE_CHILD')
  check(isProcessAlive(programPid) && isProcessAlive(childPid), '结束之前程序和它起的子进程都活着')

  await debug.stopDebugSession({ sessionId: long.sessionId }, 101)
  equal(long.ended()?.reason, 'stopped', '结束调试必须报「用户停掉的」')
  await waitFor(
    () => !isProcessAlive(programPid) && !isProcessAlive(childPid),
    '结束调试必须连程序起的子进程一起结束'
  )
  await waitFor(() => long.closed() !== null, '结束调试后运行卡必须收口')

  // 一个自己跑完的程序：环境变量到得了它手里；跑完之后调试器自己断开，进程正常退出（否则 Node 会一直
  // 等着调试器断开，卡片永远不结束）。
  const short = await start(
    { target: { kind: 'node-script', script: 'short.js', argv: [] }, env: { PROBE_LABEL: '标签 with spaces' }, breakpoints: [] },
    101
  )
  await waitFor(() => short.ended() !== undefined, '程序跑完后调试会话必须结束')
  equal(short.ended()?.reason, 'exited', '程序自己跑完必须报「退出了」')
  equal(short.ended()?.exitCode, 0, '退出码必须是程序自己的')
  equal(short.closed()?.exitCode, 0, '运行卡必须以程序的退出码收口')
  check(short.output().includes('PROBE_DONE 标签 with spaces'), '环境变量必须到被调试的程序手里')
  equal(short.paused().length, 0, '没有断点的程序不该停下')

  // 窗口关掉：它的调试会话断开，程序随它的终端会话一起结束；别的窗口的不受影响。
  const mine = await start(
    { target: { kind: 'node-script', script: 'long.js', argv: [] }, breakpoints: [{ path: 'long.js', line: 5 }] },
    101
  )
  const theirs = await start(
    { target: { kind: 'node-script', script: 'long.js', argv: [] }, breakpoints: [{ path: 'long.js', line: 5 }] },
    202
  )
  await waitFor(() => mine.paused().length === 1 && theirs.paused().length === 1, '两个窗口的程序都必须停在断点上')
  const minePid = readNumber(mine.output(), 'PROBE_PIDS')
  const mineChildPid = readNumber(mine.output(), 'PROBE_CHILD')
  await debug.closeSessionsForOwner(101)
  await terminal.closeSessionsForOwner(101)
  await waitFor(() => mine.ended() !== undefined, '窗口关掉后它的调试会话必须结束')
  await waitFor(
    () => !isProcessAlive(minePid) && !isProcessAlive(mineChildPid),
    '窗口关掉后它调试的程序必须连子进程一起结束'
  )
  equal(theirs.ended(), undefined, '别的窗口的调试会话不受影响')
  const theirScope = theirs.paused()[0]!.frames[0]!.scopes.find((scope) => scope.type === 'local')
  equal(
    (await debug.getVariables({ sessionId: theirs.sessionId, objectId: theirScope!.objectId }, 202)).variables.find(
      (variable) => variable.name === 'n'
    )?.value.text,
    '21',
    '别的窗口的程序还停在断点上、读得到变量'
  )

  // 应用退出：全部断开，终端那边把进程收掉。
  const theirPid = readNumber(theirs.output(), 'PROBE_PIDS')
  await debug.closeAllSessions()
  await terminal.closeAllSessions()
  await waitFor(() => theirs.ended() !== undefined && !isProcessAlive(theirPid), '应用退出时调试的程序必须结束')
} finally {
  await probe.close()
}

console.info(`debug probe passed (${assertionCount} assertions)`)
