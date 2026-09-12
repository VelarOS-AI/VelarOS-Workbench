import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  AgentCommandGraceMs,
  WorkbenchChatRunAttribution,
  type WorkbenchPathChangeTimeReader,
} from '../src/main/workspace/git/WorkbenchChatRunAttribution'
import type {
  WorkbenchRawPathObserver,
  WorkbenchRawPathSource,
} from '../src/main/workspace/watch/WorkbenchFileWatcher'

const Root = '/work/attribution-app'

/** 假的文件监听：测试自己决定什么时候冒出哪个路径的事件（到达多晚都行）。 */
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

/**
 * 假的文件时间戳，照真文件系统的规矩记：写文件改它自己的改动时刻，新建、删除改上级目录的，整个目录改名
 * 改的是这个目录和它的上级，里面的文件不变。测试开始前就在的路径改动时刻是 0（远早于这一轮）。
 */
function createFakeFiles(clock: { now: number }) {
  const times = new Map<string, number>()
  const removed = new Set<string>()
  const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const isRemoved = (path: string): boolean => {
    for (let current = path; current; current = parentOf(current)) if (removed.has(current)) return true
    return false
  }
  const read: WorkbenchPathChangeTimeReader = async (absolutePath) => {
    const path = absolutePath === Root ? '' : absolutePath.slice(Root.length + 1)
    return isRemoved(path) ? null : times.get(path) ?? 0
  }
  return {
    read,
    /** 改一个已有文件的内容。 */
    write: (...paths: string[]) => {
      for (const path of paths) times.set(path, clock.now)
    },
    /** 新建文件（缺的上级目录一并建出来）。 */
    create: (...paths: string[]) => {
      for (const path of paths) {
        for (let current = path; current; current = parentOf(current)) {
          const existed = !isRemoved(current) && times.has(current)
          removed.delete(current)
          times.set(current, clock.now)
          times.set(parentOf(current), clock.now)
          if (existed && current !== path) break
        }
      }
    },
    remove: (...paths: string[]) => {
      for (const path of paths) {
        removed.add(path)
        times.set(parentOf(path), clock.now)
      }
    },
    /** 整个目录改名：新目录和上级目录的改动时刻变了，里面的文件还是原来的。 */
    renameDirectory: (from: string, to: string) => {
      removed.add(from)
      removed.delete(to)
      times.set(to, clock.now)
      times.set(parentOf(from), clock.now)
      times.set(parentOf(to), clock.now)
    },
  }
}

async function createLedger(options: { unavailable?: boolean } = {}) {
  const clock = { now: 10_000 }
  const files = createFakeFiles(clock)
  const watcher = createFakeWatcher(options)
  const attribution = new WorkbenchChatRunAttribution(watcher.source, () => clock.now, files.read)
  const run = { workspaceRoot: Root, sessionId: 'session-a', recordId: 'run-1' }
  await attribution.begin(run)
  clock.now += 1_000
  const activity = attribution.activityFor({ projectRoot: Root, sessionId: 'session-a' })
  const resolve = async (paths: string[], final = false) => {
    const result = await attribution.resolve(run, paths, { final })
    assert.ok(result)
    return { watcher: result.watcher, origins: Object.fromEntries(result.origins) }
  }
  /** Agent 的写文件工具：先落盘，再报告改过的路径。 */
  const agentWrite = (write: () => void, paths: string[]): void => {
    const finish = activity.beginFileWrite()
    clock.now += 5
    write()
    clock.now += 20
    finish(paths)
  }
  /** Agent 的命令：跑着的时候写出这些改动。 */
  const agentCommand = (write: () => void): void => {
    const end = activity.beginCommand()
    clock.now += 100
    write()
    clock.now += 200
    end()
  }
  /** 让时钟走过写入回声与命令余量：之后的改动不再落在前面那些动作的窗里。 */
  const passTime = (): void => {
    clock.now += AgentCommandGraceMs * 5
  }
  return { attribution, activity, agentCommand, agentWrite, clock, files, passTime, run, resolve, watcher }
}

void describe('Workbench chat run attribution', () => {
  void test('the paths a file tool reports are the agent’s, and its own echoes arriving seconds later are not outside edits', async () => {
    const { agentWrite, clock, files, resolve, watcher } = await createLedger()

    agentWrite(() => {
      files.create('src/new/dir/a.ts')
      files.write('src/b.ts')
    }, ['src/new/dir/a.ts', './src/b.ts'])
    // macOS 忙的时候事件攒上好几秒才成批送到：看的是改动时刻，不是到达时刻。
    clock.now += 8_000
    watcher.emit('src/new/dir/a.ts', 'src/new', 'src/new/dir', 'src/b.ts')

    assert.deepEqual(await resolve(['src/new/dir/a.ts', 'src/b.ts']), {
      watcher: 'observed',
      origins: { 'src/new/dir/a.ts': 'agent', 'src/b.ts': 'agent' },
    })
  })

  void test('a command’s side effects are judged by when they changed, however late their events arrive', async () => {
    const { activity, clock, files, passTime, resolve, watcher } = await createLedger()

    // 用户在命令开跑前改了 before.md，事件却在命令跑着时才到。
    files.write('before.md')
    clock.now += 100
    const endCommand = activity.beginCommand()
    clock.now += 50
    watcher.emit('before.md')
    files.create('dist/app.js')
    clock.now += 300
    endCommand()
    // 子进程最后几笔落盘：余量之内仍算这条命令的。
    clock.now += AgentCommandGraceMs - 100
    files.create('dist/late.js')
    clock.now += 200
    files.write('notes.md')
    // 命令的事件在余量过去很久以后才到。
    passTime()
    watcher.emit('dist/app.js', 'dist', 'dist/late.js', 'notes.md')

    assert.deepEqual(
      (await resolve(['before.md', 'dist/app.js', 'dist/late.js', 'notes.md'])).origins,
      { 'dist/app.js': 'agent', 'dist/late.js': 'agent' }
    )
  })

  void test('changed paths no event reported yet are judged at capture time by when they changed', async () => {
    const { agentCommand, files, passTime, resolve } = await createLedger()

    // 一个事件都没到：命令写出的、删掉的、整个目录改名带过去的都算命令的；命令之后用户改的不算。
    agentCommand(() => {
      files.create('gen/out.txt')
      files.remove('old.txt')
      files.renameDirectory('lib', 'lib2')
    })
    passTime()
    files.write('user.md')

    assert.deepEqual(
      (await resolve(['gen/out.txt', 'old.txt', 'lib/x.ts', 'lib2/x.ts', 'user.md'], true)).origins,
      { 'gen/out.txt': 'agent', 'old.txt': 'agent', 'lib/x.ts': 'agent', 'lib2/x.ts': 'agent' }
    )
  })

  void test('a file the agent changed and someone changed afterwards is mixed even before that event arrives', async () => {
    const { agentCommand, agentWrite, files, passTime, resolve, watcher } = await createLedger()

    agentWrite(() => files.write('written.ts', 'rewritten.ts'), ['written.ts', 'rewritten.ts'])
    agentCommand(() => files.create('built.js'))
    // 命令这一下的事件先到了，认作命令的。
    watcher.emit('built.js')
    passTime()
    // Agent 自己又用命令改了 rewritten.ts：还是 Agent 的。
    agentCommand(() => files.write('rewritten.ts'))
    passTime()
    // 用户接着改了 written.ts 和 built.js，事件还没到。
    files.write('written.ts', 'built.js')

    assert.deepEqual((await resolve(['written.ts', 'rewritten.ts', 'built.js'])).origins, {
      'written.ts': 'mixed',
      'rewritten.ts': 'agent',
      'built.js': 'mixed',
    })
  })

  void test('a file touched by the agent and by someone else is mixed, including through its parent folder', async () => {
    const { attribution, activity, agentWrite, clock, files, passTime, resolve, watcher } = await createLedger()

    // 用户先在外部编辑器里改了 a.ts（事件在 Agent 动手前就到了），Agent 之后也改了它。
    files.write('src/a.ts')
    watcher.emit('src/a.ts')
    passTime()
    agentWrite(() => {
      files.write('src/a.ts')
      files.create('src/only-agent.ts')
    }, ['src/a.ts', 'src/only-agent.ts'])

    // 命令跑着的时候用户在 Workbench 编辑器里保存了 c.ts：改动时刻落在命令窗里，但保存口明确报了是用户。
    passTime()
    const endCommand = activity.beginCommand()
    clock.now += 100
    files.write('src/c.ts')
    watcher.emit('src/c.ts')
    attribution.recordUserWrites({ workspaceRoot: Root, paths: ['src/c.ts', `${Root}/src/d.ts`] })
    endCommand()

    // 用户在文件树里把 lib 整个改了名（目录级事件），Agent 之后写了里面的文件。
    passTime()
    files.renameDirectory('lib-old', 'lib')
    watcher.emit('lib')
    clock.now += 200
    agentWrite(() => files.write('lib/x.ts'), ['lib/x.ts'])

    assert.deepEqual(
      (await resolve(['src/a.ts', 'src/only-agent.ts', 'src/c.ts', 'src/d.ts', 'lib/x.ts'])).origins,
      {
        'src/a.ts': 'mixed',
        'src/only-agent.ts': 'agent',
        'src/c.ts': 'mixed',
        'lib/x.ts': 'mixed',
      }
    )
  })

  void test('a change inside a still-running file write waits for its result before it is judged', async () => {
    const { activity, clock, files, passTime, resolve, watcher } = await createLedger()

    const finish = activity.beginFileWrite()
    clock.now += 5
    files.write('src/echo.ts', 'src/someone-else.ts')
    watcher.emit('src/echo.ts', 'src/someone-else.ts')
    // 结果还没出来：先不算谁的。
    assert.deepEqual((await resolve(['src/echo.ts', 'src/someone-else.ts'])).origins, {})

    clock.now += 20
    finish(['src/echo.ts'])
    passTime()
    activity.beginFileWrite()(['src/someone-else.ts'])
    assert.deepEqual((await resolve(['src/echo.ts', 'src/someone-else.ts'])).origins, {
      'src/echo.ts': 'agent',
      'src/someone-else.ts': 'mixed',
    })

    // 一次写入到最后都没报结果：收尾时它窗里的改动一律按 AI 之外的改动算（之后才开始的写入认领不了它）。
    passTime()
    activity.beginFileWrite()
    clock.now += 5
    files.write('src/orphan.ts')
    watcher.emit('src/orphan.ts')
    passTime()
    activity.beginFileWrite()(['src/orphan.ts'])
    assert.deepEqual((await resolve(['src/orphan.ts'])).origins, { 'src/orphan.ts': 'agent' })
    assert.deepEqual((await resolve(['src/orphan.ts'], true)).origins, { 'src/orphan.ts': 'mixed' })
  })

  void test('another session’s agent writing in the same project is not this session’s agent', async () => {
    const { attribution, activity, resolve } = await createLedger()
    const other = { workspaceRoot: Root, sessionId: 'session-b', recordId: 'run-b' }
    await attribution.begin(other)
    const otherActivity = attribution.activityFor({ projectRoot: Root, sessionId: 'session-b' })

    otherActivity.beginFileWrite()(['shared.ts', 'only-b.ts'])
    activity.beginFileWrite()(['shared.ts', 'only-a.ts'])

    assert.deepEqual((await resolve(['shared.ts', 'only-a.ts', 'only-b.ts'])).origins, {
      'shared.ts': 'mixed',
      'only-a.ts': 'agent',
    })
    assert.deepEqual(
      Object.fromEntries(
        (await attribution.resolve(other, ['shared.ts', 'only-a.ts', 'only-b.ts'], { final: true }))!.origins
      ),
      { 'shared.ts': 'mixed', 'only-b.ts': 'agent' }
    )
  })

  void test('without a working watcher the change times still tell the agent’s changes apart', async () => {
    const unavailable = await createLedger({ unavailable: true })
    unavailable.agentCommand(() => unavailable.files.create('dist/generated.js'))
    unavailable.agentWrite(() => unavailable.files.write('src/tool.ts'), ['src/tool.ts'])
    unavailable.passTime()
    unavailable.files.write('notes.md')
    assert.deepEqual(await unavailable.resolve(['src/tool.ts', 'dist/generated.js', 'notes.md']), {
      watcher: 'unavailable',
      origins: { 'src/tool.ts': 'agent', 'dist/generated.js': 'agent' },
    })

    // 中途出错：之前记上的照样算，结论标明监听不完整。
    const lost = await createLedger()
    lost.agentCommand(() => lost.files.create('dist/generated.js'))
    lost.watcher.emit('dist/generated.js')
    lost.agentWrite(() => lost.files.write('src/tool.ts'), ['src/tool.ts'])
    lost.watcher.fail()
    assert.deepEqual(await lost.resolve(['src/tool.ts', 'dist/generated.js']), {
      watcher: 'unavailable',
      origins: { 'src/tool.ts': 'agent', 'dist/generated.js': 'agent' },
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
    assert.equal(await attribution.resolve(run, ['a.ts'], { final: true }), null)
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

    assert.deepEqual((await resolve(['round-1.ts', 'round-2.ts'])).origins, { 'round-1.ts': 'agent' })
    assert.deepEqual(
      Object.fromEntries((await attribution.resolve(next, ['round-1.ts', 'round-2.ts'], { final: true }))!.origins),
      { 'round-2.ts': 'agent' }
    )

    // 会话被移除：这个会话的账本全部作废。
    attribution.discard({ workspaceRoot: Root, sessionId: run.sessionId })
    assert.equal(await attribution.resolve(run, ['round-1.ts'], { final: true }), null)
    assert.equal(await attribution.resolve(next, ['round-2.ts'], { final: true }), null)
    assert.equal(watcher.observerCount(), 0)
  })
})
