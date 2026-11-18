import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'

import { OwnedChildProcess } from '../scripts/processLifecycle.mjs'

function launch(source) {
  const child = spawn(process.execPath, ['-e', source], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const owner = new OwnedChildProcess(child, {
    deadlineAt: Date.now() + 10_000,
    label: 'process lifecycle regression',
  })
  return { child, owner }
}

test('cleanup requested after physical close preserves a successful result', async () => {
  const { child, owner } = launch('process.exit(0)')
  child.once('close', () => {
    void owner.stop()
  })
  const result = await owner.done
  assert.equal(result.record?.code, 0)
  assert.equal(result.stopped, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.error, undefined)
  await owner.stop()
})

test('stopping a running child remains an interruption and waits for physical close', async () => {
  const { child, owner } = launch("console.log('ready'); setInterval(() => {}, 1000)")
  try {
    await once(child.stdout, 'data')
    await owner.stop()
    const result = await owner.done
    assert.ok(result.record)
    assert.equal(result.stopped, true)
    assert.equal(result.timedOut, false)
    assert.equal(result.error, undefined)
  } finally {
    await owner.stop()
  }
})
