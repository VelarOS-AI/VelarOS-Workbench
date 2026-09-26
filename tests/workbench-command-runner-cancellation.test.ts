import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, test } from 'bun:test'

import { CommandHelper } from '../src/main/workspace/CommandHelper'
import { CommandRunner } from '../src/main/workspace/CommandRunner'
import { PathResolver } from '../src/main/workspace/PathResolver'

class RecordingCommandHelper extends CommandHelper {
  public readonly terminationSignals: NodeJS.Signals[] = []

  public constructor(private readonly forceKillDelayMs = 50) {
    super()
  }

  public override getForceKillDelayMs(): number {
    return this.forceKillDelayMs
  }

  public override terminateForegroundProcess(
    pid: number | undefined,
    signal: NodeJS.Signals = 'SIGTERM'
  ): void {
    this.terminationSignals.push(signal)
    super.terminateForegroundProcess(pid, signal)
  }
}

void describe('Workbench command cancellation', () => {
  void test('an abort terminates the live child process, escalating when it ignores SIGTERM', async () => {
    if (process.platform === 'win32') return

    const projectRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'velaros-workbench-command-abort-'))
    )
    const markerPath = join(projectRoot, 'command.pid')
    const controller = new AbortController()
    // 强杀余量留足：机器忙时子进程也来得及先处理 SIGTERM。
    const commandHelper = new RecordingCommandHelper(500)
    const runner = new CommandRunner(new PathResolver(), commandHelper)
    let childPid: number | undefined
    let commandPromise: ReturnType<CommandRunner['runCommand']> | undefined

    try {
      // 子进程接住 SIGTERM 却不退出：先礼后兵，过了强杀余量再补一记 SIGKILL。
      const childScript = [
        "const fs = require('node:fs')",
        `const marker = ${JSON.stringify(markerPath)}`,
        "process.on('SIGTERM', () => fs.appendFileSync(marker, ':term'))",
        'fs.writeFileSync(marker, String(process.pid))',
        'setInterval(() => {}, 1_000)',
      ].join(';')

      commandPromise = runner.runCommand({
        projectRoot,
        command: `exec node -e ${quotePosixShellArgument(childScript)}`,
        timeoutMs: 10_000,
      }, undefined, controller.signal)

      childPid = Number(await waitForFile(markerPath, 3_000))
      assert.ok(Number.isInteger(childPid) && childPid > 1)

      controller.abort(new Error('test user stop'))
      const result = await commandPromise

      assert.equal(result.success, false)
      assert.equal(result.timedOut, false)
      assert.equal(result.signal, 'SIGKILL')
      assert.deepEqual(commandHelper.terminationSignals, ['SIGTERM', 'SIGKILL'])
      assert.match(await readFile(markerPath, 'utf8'), /^\d+:term$/u)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      await waitForProcessExit(childPid, 2_000)
    } finally {
      if (!controller.signal.aborted) controller.abort(new Error('test cleanup'))
      await commandPromise?.catch(() => undefined)
      if (childPid && isProcessAlive(childPid)) {
        new CommandHelper().terminateForegroundProcess(childPid, 'SIGKILL')
      }
      await rm(projectRoot, { recursive: true, force: true })
    }
  }, 15_000)

  void test('an already aborted signal refuses to start the command', async () => {
    const projectRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'velaros-workbench-command-preaborted-'))
    )
    const controller = new AbortController()
    controller.abort(new Error('stopped before start'))
    try {
      await assert.rejects(
        new CommandRunner(new PathResolver(), new CommandHelper()).runCommand({
          projectRoot,
          command: 'echo never',
        }, undefined, controller.signal),
        /stopped before start/u
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('normal completion removes the abort listener without terminating the child', async () => {
    if (process.platform === 'win32') return

    const projectRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'velaros-workbench-command-finish-'))
    )
    const controller = new AbortController()
    const commandHelper = new RecordingCommandHelper()
    const runner = new CommandRunner(new PathResolver(), commandHelper)

    try {
      const result = await runner.runCommand({
        projectRoot,
        command: `exec node -e ${quotePosixShellArgument("process.stdout.write('done')")}`,
        timeoutMs: 5_000,
      }, undefined, controller.signal)

      assert.equal(result.success, true)
      assert.equal(result.stdout, 'done')
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      controller.abort(new Error('late abort'))
      await delay(commandHelper.getForceKillDelayMs() + 25)
      assert.deepEqual(commandHelper.terminationSignals, [])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(20)
  }
  throw new Error(`Timed out waiting for child marker: ${path}`)
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await delay(20)
  }
  throw new Error(`Child process ${pid} remained alive after cancellation.`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
