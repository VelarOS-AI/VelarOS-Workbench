import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, test } from 'bun:test'

import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import { WorkbenchFileWatcher } from '../src/main/workspace/watch/WorkbenchFileWatcher'
import { shouldSkipProjectDirectory } from '../src/main/workspace/WorkbenchSkippedDirectories'
import type { SystemWorkspaceFilesChangedEvent } from '../src/shared/contracts'

import { refuseTrash } from './helpers/fakeTrash'
import { sourceSearchWorker } from './helpers/searchWorker'

/**
 * 搜索与监听只在该跳的地方跳：`.git`、`node_modules` 任何层级；`build` / `dist` / `out`
 * 只认工程根目录下的，更深处同名的目录（常是源码）照常搜得到、改了照常报；
 * 生成目录里的改动收成目录本身报一次。
 */

async function withProject(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-skipped-dirs-')))
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(projectRoot, path)), { recursive: true })
      await writeFile(join(projectRoot, path), content, 'utf8')
    }
    await run(projectRoot)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
}

void describe('Workbench skipped directories', () => {
  void test('build folders are skipped only at the project root', () => {
    for (const name of ['build', 'dist', 'out']) {
      assert.equal(shouldSkipProjectDirectory(name, true), true, name)
      assert.equal(shouldSkipProjectDirectory(name, false), false, name)
    }
    for (const name of ['node_modules', '.git', '.codegraph', '.data']) {
      assert.equal(shouldSkipProjectDirectory(name, true), true, name)
      assert.equal(shouldSkipProjectDirectory(name, false), true, name)
    }
    for (const name of ['src', 'coverage', '.github', 'vendor']) {
      assert.equal(shouldSkipProjectDirectory(name, true), false, name)
    }
  })

  void test('search finds nested build folders, not root output or dependencies', async () => {
    await withProject(
      {
        'src/build/compile.ts': 'export const needle = 1\n',
        'scripts/out/report.ts': 'export const needle = 2\n',
        'dist/bundle.js': 'const needle = 3\n',
        'packages/app/node_modules/lib/index.js': 'const needle = 4\n',
        'packages/app/dist/index.js': 'const needle = 5\n',
      },
      async (projectRoot) => {
        const parts = createWorkbenchAppParts(`${projectRoot}-data`, {
          moveToTrash: refuseTrash,
          searchWorker: sourceSearchWorker,
        })
        try {
          const content = await parts.search.searchContent({ projectRoot, query: 'needle' })
          assert.deepEqual(
            content.files.map((file) => file.path),
            ['packages/app/dist/index.js', 'scripts/out/report.ts', 'src/build/compile.ts']
          )

          const entries = await parts.search.searchEntries({ projectRoot, query: 'index' })
          assert.deepEqual(
            entries.entries.map((entry) => entry.path),
            ['packages/app/dist/index.js']
          )
          const build = await parts.search.searchEntries({ projectRoot, query: 'compile' })
          assert.deepEqual(build.entries.map((entry) => entry.path), ['src/build/compile.ts'])

          // 只搜一个子目录时，那里的 `dist` 也不是工程根目录下的构建产物。
          const scoped = await parts.search.searchContent({
            projectRoot,
            include: './packages/app',
            query: 'needle',
          })
          assert.deepEqual(
            scoped.files.map((file) => file.path),
            ['packages/app/dist/index.js']
          )
        } finally {
          await rm(`${projectRoot}-data`, { recursive: true, force: true })
        }
      }
    )
  })

  void test('the watcher reports nested build folders and collapses generated ones', async () => {
    await withProject({}, async (projectRoot) => {
      const events: SystemWorkspaceFilesChangedEvent[] = []
      const watcher = new WorkbenchFileWatcher({ debounceMs: 5 })
      try {
        const subscription = await watcher.subscribe(projectRoot, (event) => events.push(event))
        const port = watcher as unknown as { queuePath(rootPath: string, path: string): void }
        for (const path of [
          'src/build/compile.ts',
          'dist/assets/a.js',
          'dist/assets/b.js',
          'packages/app/node_modules/lib/index.js',
          'packages/app/dist/index.js',
          'node_modules/.cache/x',
          '.git/objects/ab/cdef',
          '.git/HEAD',
          'src/.git/config',
          '.codegraph/index.db',
        ]) {
          port.queuePath(subscription.workspaceRoot, path)
        }
        await delay(40)

        assert.equal(events.length, 1)
        assert.deepEqual(events[0]!.paths, [
          '.git/HEAD',
          'dist',
          'node_modules',
          'packages/app/dist/index.js',
          'packages/app/node_modules',
          'src/build/compile.ts',
        ])
        watcher.unsubscribe(subscription.subscriptionId)
      } finally {
        watcher.dispose()
      }
    })
  })
})
