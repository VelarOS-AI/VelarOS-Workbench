import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, test } from 'bun:test'

import type { ProjectKernel } from '@velaros-ai/project/runtime'

import { CommandHelper } from '../src/main/workspace/CommandHelper'
import { CommandRunner } from '../src/main/workspace/CommandRunner'
import { PathResolver } from '../src/main/workspace/PathResolver'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

class RecordingCommandHelper extends CommandHelper {
  public readonly terminationSignals: NodeJS.Signals[] = []

  public override getForceKillDelayMs(): number {
    return 50
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
  void test('a Project tool abort terminates its live child process', async () => {
    if (process.platform === 'win32') return

    const projectRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'velaros-workbench-command-abort-'))
    )
    const markerPath = join(projectRoot, 'command.pid')
    const controller = new AbortController()
    const provider = new ProjectCapabilityProvider({
      // providers 是内核契约的一部分：宿主要往里装审批 provider，桩件不能少这一格。
      createKernel: async () =>
        ({ root: projectRoot, providers: {} }) as unknown as ProjectKernel,
    })
    let childPid: number | undefined
    let commandPromise: Promise<unknown> | undefined

    try {
      const project = await provider.resolveProject(projectRoot)
      const runTool = project.tools.find((tool) => tool.name === 'project:run')
      assert.ok(runTool)

      const childScript = [
        "const fs = require('node:fs')",
        `const marker = ${JSON.stringify(markerPath)}`,
        "process.on('SIGTERM', () => fs.appendFileSync(marker, ':term'))",
        'fs.writeFileSync(marker, String(process.pid))',
        'setInterval(() => {}, 1_000)',
      ].join(';')

      commandPromise = Promise.resolve(runTool.execute({
        command: `exec node -e ${quotePosixShellArgument(childScript)}`,
        timeoutMs: 10_000,
      }, { abortSignal: controller.signal }))

      childPid = Number(await waitForFile(markerPath, 3_000))
      assert.ok(Number.isInteger(childPid) && childPid > 1)

      controller.abort(new Error('test user stop'))
      await assert.rejects(commandPromise, /test user stop/)

      assert.match(await readFile(markerPath, 'utf8'), /^\d+:term$/u)
      await waitForProcessExit(childPid, 2_000)
    } finally {
      if (!controller.signal.aborted) controller.abort(new Error('test cleanup'))
      await commandPromise?.catch(() => undefined)
      if (childPid && isProcessAlive(childPid)) {
        new CommandHelper().terminateForegroundProcess(childPid, 'SIGKILL')
      }
      await provider.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  }, 15_000)

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
