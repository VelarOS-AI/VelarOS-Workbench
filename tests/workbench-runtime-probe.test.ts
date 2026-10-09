import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
