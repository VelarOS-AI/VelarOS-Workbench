import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

test('package lock validation stays in its repository and skips nested checkouts and worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-lock-boundary-'))
  try {
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, '.git'))
    await copyFile(new URL('../scripts/refreshPrivatePackageLock.mjs', import.meta.url), join(root, 'scripts/check.mjs'))
    const dependencies = { '@velaros-ai/core': 'link:@velaros-ai/core' }
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'host', dependencies }))
    await mkdir(join(root, 'packages/feature'), { recursive: true })
    await writeFile(join(root, 'packages/feature/package.json'), JSON.stringify({ name: 'feature', dependencies }))
    await writeFile(join(root, 'bun.lock'), JSON.stringify({
      workspaces: { '': { dependencies }, 'packages/feature': { dependencies } },
      packages: { '@velaros-ai/core': ['@velaros-ai/core@link:@velaros-ai/core'] },
    }))
    for (const [name, worktree] of [['clone', false], ['worktree', true]] as const) {
      const checkout = join(root, 'scratch', name)
      await mkdir(checkout, { recursive: true })
      if (worktree) await writeFile(join(checkout, '.git'), 'gitdir: elsewhere')
      else await mkdir(join(checkout, '.git'))
      await writeFile(join(checkout, 'package.json'), JSON.stringify({ name, dependencies }))
    }
    const result = spawnSync(process.execPath, ['scripts/check.mjs', '--validate-only'], { cwd: root, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain('Private package lock is valid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
