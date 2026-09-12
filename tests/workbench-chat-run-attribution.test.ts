import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  AgentCommandGraceMs,
  WorkbenchChatRunAttribution,
} from '../src/main/workspace/git/WorkbenchChatRunAttribution'
import type {
  WorkbenchRawPathObserver,
  WorkbenchRawPathSource,
} from '../src/main/workspace/watch/WorkbenchFileWatcher'

const Root = '/work/attribution-app'

/** 假的文件监听：测试自己决定什么时候冒出哪个路径的事件。 */
function createFakeWatcher(options: { unavailable?: boolean } = {}) {
  const observers = new Set<WorkbenchRawPathObserver>()
  const source: WorkbenchRawPathSource = {
    observeRawPaths: async (workspaceRoot, observer) => {
      if (options.unavailable) throw new Error('fs.watch failed')
      observers.add(observer)
      return { workspaceRoot, stop: () => void observers.delete(observer) }
    },
  }
  return {
    source,
    emit: (...paths: string[]) => {
      for (const observer of [...observers]) for (const path of paths) observer.onPath(path)
    },
    fail: () => {
      for (const observer of [...observers]) observer.onError()
    },
    observerCount: () => observers.size,
  }
}

async function createLedger(options: { unavailable?: boolean } = {}) {
  const clock = { now: 10_000 }
  const watcher = createFakeWatcher(options)
  const attribution = new WorkbenchChatRunAttribution(watcher.source, () => clock.now)
  const run = { workspaceRoot: Root, sessionId: 'session-a', recordId: 'run-1' }
  await attribution.begin(run)
  const activity = attribution.activityFor({ projectRoot: Root, sessionId: 'session-a' })
  const resolve = (paths: string[], final = false) => {
    const result = attribution.resolve(run, paths, { final })
    assert.ok(result)
    return { watcher: result.watcher, origins: Object.fromEntries(result.origins) }
  }
  return { attribution, activity, clock, run, resolve, watcher }
}

void describe('Workbench chat run attribution', () => {
  void test('the paths a file tool reports are the agent’s, and its own watcher echoes are not outside edits', async () => {
    const { activity, clock, resolve, watcher } = await createLedger()

    const finish = activity.beginFileWrite()
    // 写入途中监听到的：新文件本身和顺带建出来的上级目录。
    watcher.emit('src/new/dir/a.ts', 'src/new', 'src/new/dir')
    clock.now += 20
    finish(['src/new/dir/a.ts', './src/b.ts'])
    // 回声晚到一点（事件合并、到达延迟）也还是它自己的。
    clock.now += 500
    watcher.emit('src/b.ts')

    assert.deepEqual(resolve(['src/new/dir/a.ts', 'src/b.ts', 'src/untouched.ts']), {
      watcher: 'observed',
      origins: { 'src/new/dir/a.ts': 'agent', 'src/b.ts': 'agent' },
    })
  })

  void test('changes seen while an agent command runs, plus a short grace, are its side effects; nothing else is', async () => {
    const { activity, clock, resolve, watcher } = await createLedger()

    watcher.emit('before.md')
    const endCommand = activity.beginCommand()
    watcher.emit('dist/app.js', 'dist')
    clock.now += 300
    endCommand()
    // 子进程最后几笔落盘、监听事件晚到：余量之内仍算这条命令的。
    clock.now += AgentCommandGraceMs - 1
    watcher.emit('dist/late.js')
    clock.now += 2
    watcher.emit('notes.md')

    assert.deepEqual(
      resolve(['before.md', 'dist/app.js', 'dist/late.js', 'notes.md']).origins,
      { 'dist/app.js': 'agent', 'dist/late.js': 'agent' }
    )
  })

  void test('a file touched by the agent and by someone else is mixed, including through its parent folder', async () => {
    const { attribution, activity, clock, resolve, watcher } = await createLedger()

    // 用户先在外部编辑器里改了 a.ts，Agent 之后也改了它。
    watcher.emit('src/a.ts')
    clock.now += 5_000
    activity.beginFileWrite()(['src/a.ts', 'src/only-agent.ts'])

    // 命令跑着的时候用户在 Workbench 编辑器里保存了 c.ts：监听到的那一下落在命令窗里，但保存口明确报了是用户。
    clock.now += 5_000
    const endCommand = activity.beginCommand()
    watcher.emit('src/c.ts')
    attribution.recordUserWrites({ workspaceRoot: Root, paths: ['src/c.ts', `${Root}/src/d.ts`] })
    endCommand()

    // 用户在文件树里把 lib 整个改了名（目录级事件），Agent 写过里面的文件。
    clock.now += 5_000
    watcher.emit('lib')
    activity.beginFileWrite()(['lib/x.ts'])

    assert.deepEqual(
      resolve(['src/a.ts', 'src/only-agent.ts', 'src/c.ts', 'src/d.ts', 'lib/x.ts']).origins,
      {
        'src/a.ts': 'mixed',
        'src/only-agent.ts': 'agent',
        'src/c.ts': 'mixed',
        'lib/x.ts': 'mixed',
      }
    )
  })

  void test('an event during a still-running file write waits for its result before it is judged', async () => {
    const { activity, clock, resolve, watcher } = await createLedger()

    const finish = activity.beginFileWrite()
    watcher.emit('src/echo.ts', 'src/someone-else.ts')
    // 结果还没出来：先不算谁的。
    assert.deepEqual(resolve(['src/echo.ts', 'src/someone-else.ts']).origins, {})

    clock.now += 50
    finish(['src/echo.ts'])
    activity.beginFileWrite()(['src/someone-else.ts'])
    assert.deepEqual(resolve(['src/echo.ts', 'src/someone-else.ts']).origins, {
      'src/echo.ts': 'agent',
      'src/someone-else.ts': 'mixed',
    })

    // 一次写入到最后都没报结果：收尾时它窗里的事件一律按 AI 之外的改动算（之后才开始的写入认领不了它）。
    activity.beginFileWrite()
    watcher.emit('src/orphan.ts')
    clock.now += 10
    activity.beginFileWrite()(['src/orphan.ts'])
    assert.deepEqual(resolve(['src/orphan.ts']).origins, { 'src/orphan.ts': 'agent' })
    assert.deepEqual(resolve(['src/orphan.ts'], true).origins, { 'src/orphan.ts': 'mixed' })
  })

  void test('another session’s agent writing in the same project is not this session’s agent', async () => {
    const { attribution, activity, resolve } = await createLedger()
    const other = { workspaceRoot: Root, sessionId: 'session-b', recordId: 'run-b' }
    await attribution.begin(other)
    const otherActivity = attribution.activityFor({ projectRoot: Root, sessionId: 'session-b' })

    otherActivity.beginFileWrite()(['shared.ts', 'only-b.ts'])
    activity.beginFileWrite()(['shared.ts', 'only-a.ts'])

    assert.deepEqual(resolve(['shared.ts', 'only-a.ts', 'only-b.ts']).origins, {
      'shared.ts': 'mixed',
      'only-a.ts': 'agent',
    })
    assert.deepEqual(
      Object.fromEntries(
        attribution.resolve(other, ['shared.ts', 'only-a.ts', 'only-b.ts'], { final: true })!.origins
      ),
      { 'shared.ts': 'mixed', 'only-b.ts': 'agent' }
    )
  })

  void test('without a working watcher only the file tools’ paths count', async () => {
    const unavailable = await createLedger({ unavailable: true })
    const endCommand = unavailable.activity.beginCommand()
    unavailable.activity.beginFileWrite()(['src/tool.ts'])
    endCommand()
    assert.deepEqual(unavailable.resolve(['src/tool.ts', 'dist/generated.js']), {
      watcher: 'unavailable',
      origins: { 'src/tool.ts': 'agent' },
    })

    // 中途出错：之前在命令窗里看到的那些也不再认——之后的外部改动可能漏记了。
    const lost = await createLedger()
    const endLostCommand = lost.activity.beginCommand()
    lost.watcher.emit('dist/generated.js')
    endLostCommand()
    lost.activity.beginFileWrite()(['src/tool.ts'])
    lost.watcher.fail()
    assert.deepEqual(lost.resolve(['src/tool.ts', 'dist/generated.js']), {
      watcher: 'unavailable',
      origins: { 'src/tool.ts': 'agent' },
    })
  })

  void test('the final capture waits out the last command’s grace, and finishing closes the ledger', async () => {
    const { attribution, activity, clock, run, watcher } = await createLedger()
    assert.equal(attribution.settleDelayMs(run), 0)

    const endCommand = activity.beginCommand()
    assert.equal(attribution.settleDelayMs(run), AgentCommandGraceMs)
    endCommand()
    clock.now += 300
    assert.equal(attribution.settleDelayMs(run), AgentCommandGraceMs - 300)
    clock.now += AgentCommandGraceMs
    assert.equal(attribution.settleDelayMs(run), 0)

    assert.equal(watcher.observerCount(), 1)
    attribution.finish(run)
    assert.equal(watcher.observerCount(), 0)
    assert.equal(attribution.resolve(run, ['a.ts'], { final: true }), null)
    // 关账之后再报的写入没有去处，也不出错。
    activity.beginFileWrite()(['a.ts'])
    activity.beginCommand()()
  })

  void test('a new round takes over the session’s reports while the previous round still resolves on its own', async () => {
    const { attribution, activity, resolve, run, watcher } = await createLedger()
    activity.beginFileWrite()(['round-1.ts'])

    const next = { ...run, recordId: 'run-2' }
    await attribution.begin(next)
    activity.beginFileWrite()(['round-2.ts'])

    assert.deepEqual(resolve(['round-1.ts', 'round-2.ts']).origins, { 'round-1.ts': 'agent' })
    assert.deepEqual(
      Object.fromEntries(attribution.resolve(next, ['round-1.ts', 'round-2.ts'], { final: true })!.origins),
      { 'round-2.ts': 'agent' }
    )

    // 会话被移除：这个会话的账本全部作废。
    attribution.discard({ workspaceRoot: Root, sessionId: run.sessionId })
    assert.equal(attribution.resolve(run, ['round-1.ts'], { final: true }), null)
    assert.equal(attribution.resolve(next, ['round-2.ts'], { final: true }), null)
    assert.equal(watcher.observerCount(), 0)
  })
})
