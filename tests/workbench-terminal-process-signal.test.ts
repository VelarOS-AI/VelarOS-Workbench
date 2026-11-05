import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

import { test } from 'bun:test'

import { signalWorkbenchProcesses } from '../src/main/workspace/terminal/WorkbenchProcessTree'

test('terminal process termination yields to the event loop and waits for taskkill', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  const closed = once(child, 'close')
  let ticked = false
  const tick = setTimeout(() => {
    ticked = true
  }, 0)
  try {
    const pending = signalWorkbenchProcesses([child.pid!], 'SIGTERM')
    assert.ok(pending instanceof Promise)
    await pending
    if (process.platform === 'win32') assert.equal(ticked, true, 'taskkill must not block timers')
    await closed
    await signalWorkbenchProcesses([child.pid!], 'SIGKILL') // 已退出的进程不会拒绝。
  } finally {
    clearTimeout(tick)
    child.kill()
  }
}, 20_000)

test('invalid and duplicate process ids are ignored before signaling', async () => {
  await signalWorkbenchProcesses([0, -1, Number.NaN, 0], 'SIGTERM')
})

test('a missing taskkill is reported instead of treated as an exited process', async () => {
  if (process.platform !== 'win32') return
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH')!
  const originalPath = process.env[pathKey]
  try {
    process.env[pathKey] = ''
    await assert.rejects(signalWorkbenchProcesses([2147483647], 'SIGTERM'), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      const cause = error.errors[0].cause as NodeJS.ErrnoException
      assert.equal(cause.code, 'ENOENT')
      return true
    })
  } finally {
    process.env[pathKey] = originalPath
  }
})
