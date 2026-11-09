import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { test } from 'bun:test'

const exec = promisify(execFile)

void test('runtime probes finish cleanup before exiting despite retained native handles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-probe-'))
  const probe = join(directory, 'probe.mjs')
  const runner = resolve('scripts/probe/electronProbeEntrypoint.mjs')
  try {
    await writeFile(probe, `
      setInterval(() => {}, 1000)
      try { await new Promise(resolve => setTimeout(resolve, 20)) }
      finally { console.log('cleanup complete') }
    `)
    const passed = await exec('node', [runner, probe], { timeout: 5_000 })
    assert.match(passed.stdout, /cleanup complete/u)

    await writeFile(probe, `setInterval(() => {}, 1000); throw new Error('probe assertion failed')`)
    await assert.rejects(() => exec('node', [runner, probe], { timeout: 5_000 }), (error: unknown) => {
      assert.equal((error as { code: number }).code, 1)
      assert.match((error as { stderr: string }).stderr, /probe assertion failed/u)
      return true
    })

    await writeFile(probe, `setInterval(() => {}, 1000); process.exitCode = 7`)
    await assert.rejects(() => exec('node', [runner, probe], { timeout: 5_000 }), (error: unknown) => {
      assert.equal((error as { code: number }).code, 7)
      return true
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

void test('runtime probe supervisor keeps unconfirmed resources after actual child close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-probe-receipt-'))
  const temporaryRoot = join(directory, 'owned-root')
  const fixture = join(directory, 'missing-receipt.mjs')
  const supervisor = join(directory, 'supervisor.mjs')
  let passed = false
  try {
    await mkdir(temporaryRoot)
    await writeFile(fixture, `
      import { writeFileSync } from 'node:fs'
      const temporaryRoot = ${JSON.stringify(temporaryRoot)}
      process.on('message', message => {
        if (message.type !== 'probe-accepted' || message.id !== 'unreleased-root') return
        writeFileSync(temporaryRoot + '/accepted.txt', 'owner accepted')
        process.send({ type: 'probe-finished', exitCode: 0 }, () => process.disconnect())
      })
      process.send({
        type: 'probe-register', id: 'unreleased-root', kind: 'temporary-root',
        pid: process.pid, temporaryRoot,
      })
    `)
    // Production's supervisor runs in Node too; keep Bun's IPC emulation out of this fault.
    await writeFile(supervisor, `
      import assert from 'node:assert/strict'
      import { fork } from 'node:child_process'
      import { readFile } from 'node:fs/promises'
      import { superviseProbeChild } from ${JSON.stringify(pathToFileURL(resolve('scripts/probe/runElectronRuntimeProbe.mjs')).href)}
      import { withinDeadline } from ${JSON.stringify(pathToFileURL(resolve('scripts/processLifecycle.mjs')).href)}
      const temporaryRoot = ${JSON.stringify(temporaryRoot)}
      const deadlineAt = Date.now() + 4000
      const child = fork(${JSON.stringify(fixture)}, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32',
      })
      let didClose = false
      const closed = new Promise(resolve => child.once('close', () => { didClose = true; resolve() }))
      try {
        await assert.rejects(superviseProbeChild(child, { deadlineAt }), error => {
          assert(error instanceof AggregateError)
          assert(error.errors.some(failure =>
            String(failure).includes('Probe cleanup receipts missing:') &&
            String(failure).includes('unreleased-root') &&
            String(failure).includes(JSON.stringify(temporaryRoot).slice(1, -1))
          ))
          return true
        })
        assert.equal(didClose, true)
        assert.equal(child.exitCode, 0)
        assert.equal(await readFile(temporaryRoot + '/accepted.txt', 'utf8'), 'owner accepted')
        console.log('missing receipt rejected after actual close')
      } finally {
        if (!didClose) {
          child.kill('SIGKILL')
          await withinDeadline(closed, deadlineAt, 'Probe fixture child close')
        }
      }
    `)
    const completed = await exec('node', [supervisor], { timeout: 5_000 })
    assert.match(completed.stdout, /missing receipt rejected after actual close/u)
    assert.equal((await stat(temporaryRoot)).isDirectory(), true)
    passed = true
  } finally {
    if (passed) await rm(directory, { recursive: true, force: true })
    else console.error(`Probe fault fixture retained for diagnosis: ${directory}`)
  }
})
