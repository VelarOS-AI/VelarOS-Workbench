import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { currentPlatform } from '@velaros-ai/core/platform'

import { resolveWorkbenchNodeExecutable } from '../src/main/conversation/WorkbenchNodeRuntime'
import { listWorkbenchProcessTree, signalWorkbenchProcesses } from '../src/main/workspace/terminal/WorkbenchProcessTree'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(process.platform !== 'win32')('stopping CMD terminates its actual Node child before releasing the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-process-tree-'))
  await writeFile(join(root, 'worker.cjs'), "require('node:fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)")
  const executable = currentPlatform.quoteShellArg(resolveWorkbenchNodeExecutable(), { kind: 'cmd' })
  const spec = currentPlatform.getShellCommandSpec(`${executable} worker.cjs`, {
    shellPath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
  })
  const child = spawn(spec.file, spec.args, {
    cwd: root, windowsVerbatimArguments: spec.windowsVerbatimArguments, windowsHide: true, stdio: 'ignore',
  })
  let targetPid = 0
  try {
    const readyDeadline = Date.now() + 10_000
    while (!targetPid && Date.now() < readyDeadline) {
      targetPid = Number(await readFile(join(root, 'pid.txt'), 'utf8').catch(() => ''))
      if (!targetPid) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert(targetPid > 0, 'the real Node child must be ready')
    const tree = await listWorkbenchProcessTree(child.pid!)
    assert(tree.includes(targetPid), 'capture the child before CMD exits')
    signalWorkbenchProcesses(tree, 'SIGTERM')
    const exitDeadline = Date.now() + 5_000
    while ((alive(child.pid!) || alive(targetPid)) && Date.now() < exitDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert(!alive(targetPid), 'the target must not be orphaned after stopping CMD')
    assert(!alive(child.pid!), 'CMD must also exit')
  } finally {
    for (const pid of [targetPid, child.pid!]) {
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
