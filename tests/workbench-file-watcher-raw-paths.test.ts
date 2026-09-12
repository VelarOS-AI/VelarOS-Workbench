import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, test } from 'bun:test'

import { WorkbenchFileWatcher } from '../src/main/workspace/watch/WorkbenchFileWatcher'

/**
 * 改动归属账本听的是原始事件：每个事件到达就交出（它要的是到达时刻），生成目录也不先滤掉（那里可能正是
 * Agent 命令的产物）；监听出错或报出没有路径的事件时要让它知道，从那里起可能漏了事件。
 */

interface WatcherTestPort {
  roots: Map<string, unknown>
  receive(rootPath: string, filename: string | null): void
}

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-watch-raw-')))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void describe('Workbench file watcher raw paths', () => {
  void test('hands every raw path over at once, generated folders included, and reports lost events', async () => {
    await withProject(async (root) => {
      const watcher = new WorkbenchFileWatcher({ debounceMs: 5 })
      const port = watcher as unknown as WatcherTestPort
      const raw: string[] = []
      let errors = 0
      const debounced: string[] = []
      try {
        const observation = await watcher.observeRawPaths(root, {
          onPath: (path) => raw.push(path),
          onError: () => {
            errors += 1
          },
        })
        const subscription = await watcher.subscribe(root, (event) => debounced.push(...event.paths))
        assert.equal(observation.workspaceRoot, root)

        port.receive(root, 'dist/app.js')
        port.receive(root, 'src/a.ts')
        port.receive(root, '../outside.ts')
        port.receive(root, null)
        // 原始事件同步交出，不等合并窗口。
        assert.deepEqual(raw, ['dist/app.js', 'src/a.ts'])
        assert.equal(errors, 1)
        await delay(30)
        // renderer 订阅照旧合并、照旧滤掉生成目录。
        assert.deepEqual(debounced, ['src/a.ts'])

        // 两边都退订之后才关掉这个根上的递归监听。
        observation.stop()
        observation.stop()
        assert.equal(port.roots.size, 1)
        watcher.unsubscribe(subscription.subscriptionId)
        assert.equal(port.roots.size, 0)
      } finally {
        watcher.dispose()
      }
    })
  })
})
