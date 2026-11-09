import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type SystemWorkspaceFilesChangedEvent } from '@shared/contracts/system'

import { WorkbenchFileWatcher } from './WorkbenchFileWatcher'

let assertions = 0

/**
 * 等一个文件事件的上限。macOS 在磁盘忙的时候把文件事件攒上好几秒才成批送达（门禁里探针紧跟在建了大量
 * 临时仓库的测试之后，实测过 4–16 秒），事件来得快时不会多等。
 */
const WatchEventTimeoutMs = 20_000
/**
 * 拥塞时 FSEvents 还会把事件并成「这个目录要重扫」、丢掉具体路径：隔这么久还没等到，就把同一个文件原样再
 * 写一遍，让它重新报一次。
 */
const RewriteAfterMs = 3_000

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1
  if (!condition) throw new Error(message)
}

/** 写一个文件，等到 `seen` 成立；迟迟等不到就原样重写。 */
async function writeUntilSeen(file: string, content: string, seen: () => boolean): Promise<boolean> {
  await writeFile(file, content)
  const startedAt = Date.now()
  let wroteAt = startedAt
  while (!seen() && Date.now() - startedAt < WatchEventTimeoutMs) {
    if (Date.now() - wroteAt >= RewriteAfterMs) {
      wroteAt = Date.now()
      await writeFile(file, content)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return seen()
}

function findPathEvent(
  events: SystemWorkspaceFilesChangedEvent[],
  path: string,
  fromIndex = 0
): SystemWorkspaceFilesChangedEvent | undefined {
  return events.slice(fromIndex).find((candidate) => candidate.paths.includes(path))
}

/** 写一个文件，等列出的每个订阅都收到这个路径的事件。 */
async function writeAndWaitForPath(
  root: string,
  path: string,
  content: string,
  subscribers: ReadonlyArray<{ events: SystemWorkspaceFilesChangedEvent[]; fromIndex: number }>
): Promise<SystemWorkspaceFilesChangedEvent[]> {
  const seenBy = (): Array<SystemWorkspaceFilesChangedEvent | undefined> =>
    subscribers.map(({ events, fromIndex }) => findPathEvent(events, path, fromIndex))
  await writeUntilSeen(join(root, path), content, () => seenBy().every(Boolean))
  const events = seenBy()
  if (!events.every(Boolean)) throw new Error(`watch event timeout for ${path}`)
  return events as SystemWorkspaceFilesChangedEvent[]
}

const root = await mkdtemp(join(tmpdir(), 'velaros-workbench-watch-'))
const service = new WorkbenchFileWatcher({ debounceMs: 30, now: () => 123 })

try {
  // Real workspaces already contain these directories when a subscription starts. Linux
  // recursive fs.watch does not guarantee that a write immediately following a new directory
  // creation is observed before the native watcher has attached to that directory.
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'node_modules'))
  await mkdir(join(root, 'build'))

  const firstEvents: SystemWorkspaceFilesChangedEvent[] = []
  const secondEvents: SystemWorkspaceFilesChangedEvent[] = []
  const first = await service.subscribe(root, (event) => firstEvents.push(event))
  const second = await service.subscribe(root, (event) => secondEvents.push(event))

  assert(first.subscriptionId !== second.subscriptionId, 'subscriptions must be isolated')
  assert(first.workspaceRoot === (await realpath(root)), 'root must be canonical')

  const [event] = await writeAndWaitForPath(root, 'one.ts', 'one', [
    { events: firstEvents, fromIndex: 0 },
    { events: secondEvents, fromIndex: 0 },
  ])

  const [secondPathEvent] = await writeAndWaitForPath(root, 'two.ts', 'two', [
    { events: firstEvents, fromIndex: firstEvents.length },
    { events: secondEvents, fromIndex: secondEvents.length },
  ])

  assert(event.kind === 'velaros.systemWorkspaceFilesChanged', 'event kind must be stable')
  assert(event.source === 'filesystem-watch', 'event source must identify watcher')
  assert(event.rootPath === first.workspaceRoot, 'event root must be canonical')
  assert(event.changedAt === 123, 'event timestamp must use dependency clock')
  assert(event.paths.includes('one.ts'), 'first path must be reported')
  assert(secondPathEvent.paths.includes('two.ts'), 'second path must be reported')
  assert(event.sessionIds.length === 0, 'standalone watcher must not invent sessions')

  service.unsubscribe(first.subscriptionId)
  const firstCount = firstEvents.length
  const [secondEvent] = await writeAndWaitForPath(root, 'three.ts', 'three', [
    { events: secondEvents, fromIndex: secondEvents.length },
  ])
  assert(secondEvent.paths.includes('three.ts'), 'remaining subscriber must receive changes')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert(firstEvents.length === firstCount, 'released subscriber must receive no changes')

  const [gitEvent] = await writeAndWaitForPath(root, '.git/HEAD', 'ref: refs/heads/main\n', [
    { events: secondEvents, fromIndex: secondEvents.length },
  ])
  assert(gitEvent.paths.includes('.git/HEAD'), 'Git state changes must refresh Git surfaces')

  // 依赖目录里的写入只报目录本身：展开着的 node_modules 会刷新，但不把成千上万个文件路径灌给订阅方。
  const beforeDependencyWrite = secondEvents.length
  const dependencySeen = await writeUntilSeen(
    join(root, 'node_modules', 'ignored.js'),
    'ignored',
    () => findPathEvent(secondEvents, 'node_modules', beforeDependencyWrite) !== undefined
  )
  assert(
    dependencySeen && secondEvents
      .slice(beforeDependencyWrite)
      .every((candidate) => candidate.paths.every((path) => path === 'node_modules')),
    'writes in dependency directories must be reported as the directory itself'
  )

  // 改动归属账本听原始事件：生成目录里的写入照样交出（可能正是 Agent 命令的产物），renderer 订阅仍滤掉。
  const rawPaths = new Set<string>()
  const observation = await service.observeRawPaths(root, {
    onPath: (path) => void rawPaths.add(path),
    onError: () => undefined,
  })
  const beforeBuildWrite = secondEvents.length
  assert(
    await writeUntilSeen(join(root, 'build', 'out.js'), 'built', () => rawPaths.has('build/out.js')),
    'raw observers must see writes in generated directories'
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert(
    secondEvents.slice(beforeBuildWrite).every((candidate) => !candidate.paths.includes('build/out.js')),
    'subscribers must keep generated directories filtered'
  )
  observation.stop()

  service.unsubscribe(second.subscriptionId)
  service.dispose()
  assert(true, 'dispose is idempotent after final unsubscribe')
} finally {
  service.dispose()
  await rm(root, { recursive: true, force: true })
}

console.info(`workbench watch probe passed (${assertions} assertions)`)
