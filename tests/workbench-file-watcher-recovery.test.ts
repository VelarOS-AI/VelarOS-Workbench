import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, mock, test } from 'bun:test'

import { WorkbenchFileWatcher } from '../src/main/workspace/watch/WorkbenchFileWatcher'
import { isSameOrChildPath } from '../src/renderer/src/models/shared/workbenchUtils'
import { type SystemWorkspaceFilesChangedEvent } from '../src/shared/contracts/system'
import {
  WorkbenchWatchChannels,
  type WorkbenchWatchStatus,
} from '../src/shared/workbenchWatch'

/**
 * 文件监听不会悄悄停掉：出错后按退避间隔重启，恢复时补发一次整个根目录的变更；起不来就把「不可用」
 * 报给订阅方，恢复后再报「在监听」；说不清是哪个文件的事件按整个根目录变了报。
 */

class FakeWatcher extends EventEmitter {
  public closed = false

  public close(): void {
    this.closed = true
  }
}

interface FakeWatchHarness {
  watchers: FakeWatcher[]
  changes: Array<(filename: Nullable<string>) => void>
  failWith: Nullable<Error>
  watch: (rootPath: string, onChange: (filename: Nullable<string>) => void) => FSWatcher
}

function createFakeWatch(): FakeWatchHarness {
  const harness: FakeWatchHarness = {
    watchers: [],
    changes: [],
    failWith: null,
    watch: (_rootPath, onChange) => {
      if (harness.failWith) throw harness.failWith
      const watcher = new FakeWatcher()
      harness.watchers.push(watcher)
      harness.changes.push(onChange)
      return watcher as unknown as FSWatcher
    },
  }
  return harness
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    assert.ok(waited < 2_000, `timed out waiting for ${label}`)
    await delay(5)
  }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-watch-recovery-')))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void describe('Workbench file watcher recovery', () => {
  void test('project release and window destruction both reclaim subscriptions that finish late', async () => {
    await withRoot(async (root) => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>()
      void mock.module('electron', () => ({
        ipcMain: {
          handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(channel, handler)
          },
          removeHandler: (channel: string) => handlers.delete(channel),
        },
      }))
      const { registerWorkbenchWatchIpc } = await import(
        '../src/main/workspace/watch/WorkbenchWatchIpc'
      )
      const fake = createFakeWatch()
      const watcher = new WorkbenchFileWatcher({ watch: fake.watch })
      const subscribe = watcher.subscribe.bind(watcher)
      let gate = Promise.withResolvers<void>()
      watcher.subscribe = async (...args) => {
        await gate.promise
        return subscribe(...args)
      }
      const sender = Object.assign(new EventEmitter(), {
        id: 73,
        destroyed: false,
        isDestroyed(): boolean {
          return this.destroyed
        },
        send(): void {},
      })
      const registration = registerWorkbenchWatchIpc(watcher)
      const start = handlers.get(WorkbenchWatchChannels.start)
      assert.ok(start)
      const pending: Array<Promise<unknown>> = []
      const begin = (): Promise<{ ok: boolean; code?: string }> => {
        const request = Promise.resolve(start({ sender }, { workspaceRoot: root })) as Promise<{
          ok: boolean
          code?: string
        }>
        pending.push(request)
        return request
      }
      try {
        const projectClosed = begin()
        registration.closeSubscriptionsForSender(sender.id)
        gate.resolve()
        assert.deepEqual(await projectClosed, {
          ok: false,
          code: 'CLOSED',
          message: 'File watch owner is no longer active.',
        })
        assert.equal(fake.watchers[0]?.closed, true)
        assert.equal(sender.isDestroyed(), false)

        gate = Promise.withResolvers<void>()
        const windowClosed = begin()
        sender.destroyed = true
        sender.emit('destroyed')
        gate.resolve()
        assert.equal((await windowClosed).code, 'CLOSED')
        assert.equal(fake.watchers.length, 2)
        assert.ok(fake.watchers.every((watch) => watch.closed))
      } finally {
        gate.resolve()
        await Promise.allSettled(pending)
        registration.dispose()
      }
    })
  })

  void test('disposing the watcher rejects pending subscriptions and raw observations before watching starts', async () => {
    await withRoot(async (root) => {
      const fake = createFakeWatch()
      const watcher = new WorkbenchFileWatcher({ watch: fake.watch })
      const resolver = watcher as unknown as { resolveRoot: (input: string) => Promise<string> }
      const resolveRoot = resolver.resolveRoot.bind(watcher)
      const rootsResolved = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      let resolvedCount = 0
      // 卡在真实根解析之后：两个入口都已进入 await，尚未走共同的监听准入。
      resolver.resolveRoot = async (input) => {
        const rootPath = await resolveRoot(input)
        resolvedCount += 1
        if (resolvedCount === 2) rootsResolved.resolve()
        await gate.promise
        return rootPath
      }
      const subscription = watcher.subscribe(root, () => undefined)
      const observation = watcher.observeRawPaths(root, {
        onPath: () => undefined,
        onError: () => undefined,
      })
      try {
        await rootsResolved.promise
        watcher.dispose()
        const rejected = Promise.all([
          assert.rejects(subscription, { code: 'CLOSED' }),
          assert.rejects(observation, { code: 'CLOSED' }),
        ])
        gate.resolve()
        await rejected
        assert.equal(fake.watchers.length, 0)
      } finally {
        gate.resolve()
        await Promise.allSettled([subscription, observation])
        watcher.dispose()
      }
    })
  })

  void test('a watcher error restarts watching and refreshes the whole root', async () => {
    await withRoot(async (root) => {
      const fake = createFakeWatch()
      const watcher = new WorkbenchFileWatcher({
        debounceMs: 5,
        watch: fake.watch,
        restartBaseDelayMs: 10,
      })
      const events: SystemWorkspaceFilesChangedEvent[] = []
      const statuses: WorkbenchWatchStatus[] = []
      let rawErrors = 0
      try {
        const subscription = await watcher.subscribe(
          root,
          (event) => events.push(event),
          (status) => statuses.push(status)
        )
        const observation = await watcher.observeRawPaths(root, {
          onPath: () => undefined,
          onError: () => {
            rawErrors += 1
          },
        })
        assert.deepEqual(subscription.status, { state: 'watching' })
        assert.equal(fake.watchers.length, 1)

        fake.watchers[0]!.emit('error', new Error('EMFILE: too many open files'))
        assert.equal(fake.watchers[0]!.closed, true)
        assert.equal(rawErrors, 1)

        await waitFor(() => fake.watchers.length === 2, 'the restarted watcher')
        await waitFor(() => events.length === 1, 'the whole-root refresh')
        assert.deepEqual(events[0]!.paths, ['.'])
        // 一次就重启成功：没停过，不用打扰用户。
        assert.deepEqual(statuses, [])

        // 重启后的监听照常送事件。
        fake.changes[1]!('src/a.ts')
        await waitFor(() => events.length === 2, 'events from the restarted watcher')
        assert.deepEqual(events[1]!.paths, ['src/a.ts'])
        observation.stop()
        watcher.unsubscribe(subscription.subscriptionId)
      } finally {
        watcher.dispose()
      }
    })
  })

  void test('watching that cannot run is reported until it recovers', async () => {
    await withRoot(async (root) => {
      const fake = createFakeWatch()
      fake.failWith = new Error('ENOSPC: System limit for number of file watchers reached')
      const watcher = new WorkbenchFileWatcher({
        debounceMs: 5,
        watch: fake.watch,
        restartBaseDelayMs: 10,
        restartMaxDelayMs: 20,
      })
      const events: SystemWorkspaceFilesChangedEvent[] = []
      const statuses: WorkbenchWatchStatus[] = []
      try {
        const subscription = await watcher.subscribe(
          root,
          (event) => events.push(event),
          (status) => statuses.push(status)
        )
        assert.equal(subscription.status.state, 'unavailable')
        assert.match(subscription.status.message ?? '', /ENOSPC/u)

        // 后台一直在试；原因没变就不重复报。
        await delay(60)
        assert.equal(fake.watchers.length, 0)
        assert.deepEqual(statuses, [])

        fake.failWith = null
        await waitFor(() => statuses.length === 1, 'the recovery status')
        assert.deepEqual(statuses, [{ state: 'watching' }])
        await waitFor(() => events.length === 1, 'the whole-root refresh')
        assert.deepEqual(events[0]!.paths, ['.'])

        // 运行中出错、重启又起不来：这才报不可用。
        fake.failWith = new Error('EPERM: operation not permitted')
        fake.watchers[0]!.emit('error', new Error('watcher died'))
        await waitFor(() => statuses.length === 2, 'the unavailable status')
        assert.equal(statuses[1]!.state, 'unavailable')
        assert.match(statuses[1]!.message ?? '', /EPERM/u)
        watcher.unsubscribe(subscription.subscriptionId)
      } finally {
        watcher.dispose()
      }
    })
  })

  void test('raw observers learn when watching is unavailable on arrival and resume after recovery', async () => {
    await withRoot(async (root) => {
      const fake = createFakeWatch()
      fake.failWith = new Error('ENOSPC: System limit for number of file watchers reached')
      const watcher = new WorkbenchFileWatcher({
        watch: fake.watch,
        restartBaseDelayMs: 10,
      })
      const firstPaths: string[] = []
      const secondPaths: string[] = []
      let firstErrors = 0
      let secondErrors = 0
      try {
        const first = await watcher.observeRawPaths(root, {
          onPath: (path) => firstPaths.push(path),
          onError: () => {
            firstErrors += 1
          },
        })
        assert.equal(firstErrors, 1)

        const second = await watcher.observeRawPaths(root, {
          onPath: (path) => secondPaths.push(path),
          onError: () => {
            secondErrors += 1
          },
        })
        assert.equal(secondErrors, 1)
        assert.equal(firstErrors, 1)
        assert.equal(fake.watchers.length, 0)

        fake.failWith = null
        await waitFor(() => fake.watchers.length === 1, 'raw observation recovery')
        fake.changes[0]!('src/a.ts')
        assert.deepEqual(firstPaths, ['src/a.ts'])
        assert.deepEqual(secondPaths, ['src/a.ts'])
        assert.equal(firstErrors, 1)
        assert.equal(secondErrors, 1)

        first.stop()
        assert.equal(fake.watchers[0]!.closed, false)
        second.stop()
        assert.equal(fake.watchers[0]!.closed, true)
      } finally {
        watcher.dispose()
      }
    })
  })

  void test('restarts back off and stop once nobody listens', async () => {
    await withRoot(async (root) => {
      const fake = createFakeWatch()
      fake.failWith = new Error('EACCES')
      let attempts = 0
      const watcher = new WorkbenchFileWatcher({
        watch: (rootPath, onChange) => {
          attempts += 1
          return fake.watch(rootPath, onChange)
        },
        restartBaseDelayMs: 20,
        restartMaxDelayMs: 40,
      })
      try {
        const subscription = await watcher.subscribe(root, () => undefined)
        // 20ms、40ms、40ms……：第一次失败是订阅时，之后按退避间隔。
        await delay(130)
        assert.ok(attempts >= 2 && attempts <= 5, `attempts: ${attempts}`)

        watcher.unsubscribe(subscription.subscriptionId)
        const afterUnsubscribe = attempts
        await delay(100)
        assert.equal(attempts, afterUnsubscribe)
      } finally {
        watcher.dispose()
      }
    })
  })

  void test('events without a file name refresh the whole root', async () => {
    await withRoot(async (root) => {
      const fake = createFakeWatch()
      const watcher = new WorkbenchFileWatcher({ debounceMs: 5, watch: fake.watch })
      const events: SystemWorkspaceFilesChangedEvent[] = []
      try {
        const subscription = await watcher.subscribe(root, (event) => events.push(event))
        fake.changes[0]!(null)
        fake.changes[0]!('')
        await waitFor(() => events.length === 1, 'the whole-root refresh')
        assert.deepEqual(events[0]!.paths, ['.'])
        watcher.unsubscribe(subscription.subscriptionId)
      } finally {
        watcher.dispose()
      }
    })
  })

  void test('the renderer treats a whole-root change as touching every open file', () => {
    assert.equal(isSameOrChildPath('src/a.ts', '.'), true)
    assert.equal(isSameOrChildPath('.', '.'), true)
    assert.equal(isSameOrChildPath('src/a.ts', 'src'), true)
    assert.equal(isSameOrChildPath('src-old/a.ts', 'src'), false)

    const hook = readFileSync('src/renderer/src/support/useWorkspaceFilesChangedRefresh.ts', 'utf8')
    // 订阅不上也要报出来，不能当成在监听。
    assert.match(hook, /reportStartFailure\(result\.message\)/u)
    assert.match(hook, /handleWatchStatus\(result\.value\.status\)/u)
    assert.match(hook, /window\.velarosWorkbenchWatch\.onStatus\(/u)
    const pageModel = readFileSync(
      'src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx',
      'utf8'
    )
    assert.match(pageModel, /onWatchStatus: showWorkspaceWatchStatus/u)
    assert.match(pageModel, /duration: Number\.POSITIVE_INFINITY/u)
    assert.match(pageModel, /message\.dismiss\(WorkspaceWatchUnavailableNoticeId\)/u)
    const messageHost = readFileSync('src/renderer/src/runtime/workbenchMessageHost.tsx', 'utf8')
    // 固定 id 的提示不走去重窗口，可以按 id 收起。
    assert.match(
      messageHost,
      /if \(!options\.id && messageDedupe\.shouldSkip\(normalizedOptions\)\) return/u
    )
    assert.match(messageHost, /toast\.dismiss\(id\)/u)
  })
})
