import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, test } from 'bun:test'

import { WorkbenchFileWatcher } from '../src/main/workspace/watch/WorkbenchFileWatcher'
import { type SystemWorkspaceFilesChangedEvent } from '../src/shared/contracts/system'

void describe('Workbench file watcher language synchronization', () => {
  void test('coalesces one project batch before notifying language services and subscribers', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-watch-language-'))
    const languageEvents: SystemWorkspaceFilesChangedEvent[] = []
    const rendererEvents: SystemWorkspaceFilesChangedEvent[] = []
    const watcher = new WorkbenchFileWatcher({
      debounceMs: 5,
      now: () => 123,
      onFilesChanged: (event) => languageEvents.push(event),
    })
    try {
      const subscription = await watcher.subscribe(projectRoot, (event) => rendererEvents.push(event))
      const testPort = watcher as unknown as {
        queuePath(rootPath: string, path: string): void
      }
      testPort.queuePath(subscription.workspaceRoot, 'src/second.vel')
      testPort.queuePath(subscription.workspaceRoot, 'src/first.vel')
      testPort.queuePath(subscription.workspaceRoot, 'src/first.vel')
      testPort.queuePath(subscription.workspaceRoot, 'node_modules/ignored.vel')
      await delay(30)

      assert.equal(languageEvents.length, 1)
      assert.equal(rendererEvents.length, 1)
      assert.equal(languageEvents[0], rendererEvents[0])
      assert.deepEqual(languageEvents[0], {
        kind: 'velaros.systemWorkspaceFilesChanged',
        source: 'filesystem-watch',
        rootPath: subscription.workspaceRoot,
        // 依赖目录里的改动收成目录本身，不逐个文件报。
        paths: ['node_modules', 'src/first.vel', 'src/second.vel'],
        sessionIds: [],
        changedAt: 123,
      })
      watcher.unsubscribe(subscription.subscriptionId)
    } finally {
      watcher.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
