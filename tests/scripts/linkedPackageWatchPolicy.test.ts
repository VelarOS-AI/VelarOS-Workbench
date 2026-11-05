import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { test } from 'bun:test'
import { createServer, normalizePath, resolveConfig } from 'vite'

import {
  isolateLinkedPackageWatcher,
  linkedPackageWatchIgnore,
} from '../../scripts/linkedPackageWatchPolicy'

test('linked package writes do not reload Workbench; own sources remain watched', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-watch-')))
  const repo = join(root, 'app')
  const linked = join(root, 'shared')
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    await mkdir(join(repo, 'node_modules/@velaros-ai'), { recursive: true })
    await mkdir(linked)
    await symlink(
      linked,
      join(repo, 'node_modules/@velaros-ai/velaros'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const main = join(repo, 'main.js')
    const dependency = join(linked, 'index.js')
    await writeFile(main, 'export const app = 1')
    await writeFile(dependency, 'export const shared = 1')
    const ignored = linkedPackageWatchIgnore(repo)
    server = await createServer({
      root: repo,
      configFile: false,
      server: { fs: { allow: [root] }, watch: { ignored: [ignored] } },
    })
    await server.listen(0, '127.0.0.1')
    await server.transformRequest('/main.js')
    await server.transformRequest(`/@fs/${normalizePath(dependency)}`)
    const changes: string[] = []
    server.watcher.on('change', (path) => changes.push(normalizePath(path)))
    await delay(100)
    await writeFile(dependency, 'export const shared = 2')
    await writeFile(main, 'export const app = 2')
    const until = Date.now() + 3000
    while (!changes.some((path) => path.endsWith('/app/main.js')) && Date.now() < until)
      await delay(20)
    await delay(150)
    assert.ok(changes.some((path) => path.endsWith('/app/main.js')))
    assert.ok(!changes.some((path) => path.endsWith('/shared/index.js')))
    const plugin = isolateLinkedPackageWatcher(ignored)
    const normal = await resolveConfig(
      { configFile: false, root: repo, plugins: [plugin] },
      'build'
    )
    assert.ok(!normal.build.watch)
    const watched = await resolveConfig(
      { configFile: false, root: repo, plugins: [plugin], build: { watch: {} } },
      'build'
    )
    assert.ok(watched.build.watch && Array.isArray(watched.build.watch.exclude))
    assert.ok(
      watched.build.watch.exclude.some(
        (pattern) => pattern instanceof RegExp && pattern.test(normalizePath(dependency))
      )
    )
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
