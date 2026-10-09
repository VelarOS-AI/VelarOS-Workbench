import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { CommandHelper } from '../src/main/workspace/CommandHelper'
import { CommandRunner } from '../src/main/workspace/CommandRunner'
import { PathResolver } from '../src/main/workspace/PathResolver'

test('absolute command cwd follows the selected root alias while child symlink escapes remain denied', async () => {
  const base = await mkdtemp(join(tmpdir(), 'workbench-root-alias-'))
  const canonical = join(base, 'project')
  const alias = join(base, 'alias')
  await mkdir(join(canonical, 'src'), { recursive: true })
  await mkdir(join(base, 'outside'))
  await symlink(canonical, alias, 'dir')
  await symlink(join(base, 'outside'), join(canonical, 'escape'), 'dir')
  const runner = new CommandRunner(new PathResolver(), new CommandHelper())
  try {
    for (const cwd of [alias, join(alias, 'src'), await realpath(join(canonical, 'src'))]) {
      const result = await runner.runCommand({ projectRoot: alias, cwd, command: process.platform === 'win32' ? 'cd' : 'pwd', timeoutMs: 5000 })
      assert.equal(result.exitCode, 0)
      assert.equal(result.cwd, await realpath(cwd))
    }
    await assert.rejects(runner.runCommand({ projectRoot: alias, cwd: join(alias, 'escape'), command: process.platform === 'win32' ? 'cd' : 'pwd' }), /路径超出工程范围/)
    await assert.rejects(runner.runCommand({ projectRoot: alias, cwd: join(base, 'outside'), command: process.platform === 'win32' ? 'cd' : 'pwd' }), /路径超出工程范围/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
