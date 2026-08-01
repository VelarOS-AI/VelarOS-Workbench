import { strict as assert } from 'node:assert'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandHelper } from '../CommandHelper'
import { PathResolver } from '../PathResolver'

import {
  buildTerminalCwdProbeCommand,
  scanTerminalCwdMarkers,
  TERMINAL_CWD_MARKER_END,
  TERMINAL_CWD_MARKER_START,
} from './terminalCwdMarker'
import { TerminalSessions } from './TerminalSessions'

let assertionCount = 0

function check(value: unknown, message: string): asserts value {
  assert.ok(value, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

const wholeMarker = `${TERMINAL_CWD_MARKER_START}/tmp/project${TERMINAL_CWD_MARKER_END}`
const whole = scanTerminalCwdMarkers(`before${wholeMarker}after`)
equal(whole.text, 'beforeafter', '完整 cwd 标记必须从可见输出剥离')
equal(whole.cwd, '/tmp/project', '完整 cwd 标记必须恢复目录')
equal(whole.carry, '', '完整 cwd 标记不得留下 carry')

const markerCut = Math.floor(wholeMarker.length / 2)
const first = scanTerminalCwdMarkers(`visible${wholeMarker.slice(0, markerCut)}`)
equal(first.text, 'visible', '半截 cwd 标记不得泄漏到可见输出')
check(first.carry.length > 0, '半截 cwd 标记必须进入 carry')
const second = scanTerminalCwdMarkers(first.carry + wholeMarker.slice(markerCut))
equal(second.cwd, '/tmp/project', '跨 chunk cwd 标记必须恢复目录')
equal(second.text, '', '跨 chunk cwd 标记不得留下控制字节')

check(
  buildTerminalCwdProbeCommand('darwin').includes('$PWD'),
  'POSIX cwd 探针必须由 shell 自身读取 PWD'
)
check(
  buildTerminalCwdProbeCommand('win32').includes('Get-Location'),
  'Windows cwd 探针必须读取当前 PowerShell 目录'
)

const projectRoot = mkdtempSync(join(tmpdir(), 'velaros-workbench-terminal-probe-'))
const terminal = new TerminalSessions(new PathResolver(), new CommandHelper())

try {
  await assert.rejects(
    terminal.startTerminalSession({ projectRoot, cwd: '..' }, () => undefined),
    /超出工程范围/,
    '终端 cwd 越界必须拒绝'
  )
  assertionCount += 1

  const output: string[] = []
  let resolveClosed: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const session = await terminal.startTerminalSession(
    {
      projectRoot,
      initialCommand: "printf 'VELAROS_TERMINAL_PROBE_OK\\n'; exit",
    },
    (event) => {
      output.push(event.chunk)
      if (event.closed) resolveClosed?.()
    }
  )
  check(session.sessionId.startsWith('terminal-'), '终端会话必须返回独立持久句柄')
  equal(session.projectRoot, realpathSync(projectRoot), '终端会话必须绑定 canonical 项目根')

  await Promise.race([
    closed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('终端真实会话未在 5 秒内退出')), 5_000)
    }),
  ])
  check(
    output.join('').includes('VELAROS_TERMINAL_PROBE_OK'),
    '终端真实会话必须把 stdout 回传给 renderer 订阅面'
  )

  await terminal.closeAllSessions()
  assertionCount += 1
} finally {
  await terminal.closeAllSessions()
  rmSync(projectRoot, { recursive: true, force: true })
}

console.info(`workbench terminal probe: ${assertionCount} assertions passed`)
