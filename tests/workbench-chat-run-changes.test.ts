import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { WorkbenchChatCheckpointService } from '../src/main/workspace/git/WorkbenchChatCheckpoints'
import {
  AgentCommandGraceMs,
  type WorkbenchAgentProjectActivityPort,
  WorkbenchChatRunAttribution,
} from '../src/main/workspace/git/WorkbenchChatRunAttribution'
import { WorkbenchChatRunChangeStore } from '../src/main/workspace/git/WorkbenchChatRunChanges'
import type {
  WorkbenchRawPathObserver,
  WorkbenchRawPathSource,
} from '../src/main/workspace/watch/WorkbenchFileWatcher'

const execFileAsync = promisify(execFile)

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root })
  return stdout
}

interface RepositoryFixture {
  repo: string
  project: string
  records: string
  checkpoints: WorkbenchChatCheckpointService
  store: WorkbenchChatRunChangeStore
}

async function withRepository(run: (fixture: RepositoryFixture) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'workbench-run-changes-'))
  const indexes = await mkdtemp(join(tmpdir(), 'workbench-run-changes-indexes-'))
  const records = await mkdtemp(join(tmpdir(), 'workbench-run-changes-records-'))
  const checkpoints = new WorkbenchChatCheckpointService(() => indexes)
  const store = new WorkbenchChatRunChangeStore(checkpoints, () => records, () => 1_757_000_000_000)
  try {
    await git(repo, ['init', '-q'])
    // 项目只是大仓里的一个子目录：本轮改动只看项目根之内，路径相对项目根。
    const project = join(repo, 'app')
    await mkdir(project)
    await writeFile(join(repo, 'outside.txt'), 'outside\n', 'utf8')
    await writeFile(join(project, 'tracked.ts'), 'export const a = 1\nexport const b = 1\n', 'utf8')
    await writeFile(join(project, 'removed.ts'), 'bye\n', 'utf8')
    await writeFile(join(project, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    await git(repo, ['add', '-A'])
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
    await run({ repo, project, records, checkpoints, store })
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(indexes, { recursive: true, force: true })
    await rm(records, { recursive: true, force: true })
  }
}

void describe('Workbench chat run changes', () => {
  void test('records the files a run changed on disk and keeps only a summary for the marker', async () => {
    await withRepository(async ({ repo, project, checkpoints, store }) => {
      const { commitId } = await checkpoints.capture({
        workspaceRoot: project,
        sessionId: 'workbench-session',
        checkpointId: 'run-1',
      })
      assert.ok(commitId)
      const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).trim()

      await writeFile(join(project, 'tracked.ts'), 'export const a = 2\nexport const b = 1\n', 'utf8')
      await unlink(join(project, 'removed.ts'))
      await writeFile(join(project, 'created.ts'), 'new\n', 'utf8')
      await writeFile(join(project, 'image.bin'), Buffer.from([0, 9, 9, 9, 0, 255]))
      await writeFile(join(project, 'odd\tname.ts'), 'tab in the name\n', 'utf8')
      await writeFile(join(project, 'generated.ts'), 'line\n'.repeat(5_000), 'utf8')
      await writeFile(join(repo, 'outside.txt'), 'changed outside the project\n', 'utf8')

      const summary = await store.capture({
        workspaceRoot: project,
        sessionId: 'workbench-session',
        recordId: 'run-1',
        baseCommitId: commitId,
      })
      assert.deepEqual(summary, {
        recordId: 'run-1',
        capturedAt: 1_757_000_000_000,
        fileCount: 6,
        additions: 1 + 1 + 1 + 5_000,
        deletions: 1 + 1,
        error: null,
        paths: ['created.ts', 'generated.ts', 'image.bin', 'odd\tname.ts', 'removed.ts', 'tracked.ts'],
      })

      const record = await store.read({
        workspaceRoot: project,
        sessionId: 'workbench-session',
        recordId: 'run-1',
      })
      assert.ok(record)
      const byPath = new Map(record.changes.map((change) => [change.path, change]))
      assert.deepEqual([...byPath.keys()].sort(), [
        'created.ts',
        'generated.ts',
        'image.bin',
        'odd\tname.ts',
        'removed.ts',
        'tracked.ts',
      ])
      assert.equal(byPath.get('created.ts')?.status, 'added')
      assert.equal(byPath.get('removed.ts')?.status, 'deleted')
      assert.equal(byPath.get('tracked.ts')?.status, 'modified')
      assert.match(byPath.get('tracked.ts')?.patch ?? '', /^-export const a = 1$/mu)
      assert.match(byPath.get('tracked.ts')?.patch ?? '', /^\+export const a = 2$/mu)
      assert.deepEqual(
        { binary: byPath.get('image.bin')?.binary, patch: byPath.get('image.bin')?.patch },
        { binary: true, patch: '' }
      )
      // 超过单文件行数上限：计数照记，逐行补丁不存。
      assert.deepEqual(
        {
          additions: byPath.get('generated.ts')?.additions,
          patch: byPath.get('generated.ts')?.patch,
          patchOmitted: byPath.get('generated.ts')?.patchOmitted,
        },
        { additions: 5_000, patch: '', patchOmitted: true }
      )

      // 采集只写影子 index 与 tree 对象：用户的分支、暂存区原样。
      assert.equal((await git(repo, ['rev-parse', 'HEAD'])).trim(), headBefore)
      assert.equal((await git(repo, ['diff', '--cached', '--name-only'])).trim(), '')

      await store.delete({
        workspaceRoot: project,
        sessionId: 'workbench-session',
        recordIds: ['run-1', 'never-written'],
      })
      assert.equal(
        await store.read({ workspaceRoot: project, sessionId: 'workbench-session', recordId: 'run-1' }),
        null
      )
    })
  })

  void test('reads a changed file as it was before the run, only for files the record lists', async () => {
    await withRepository(async ({ project, checkpoints, store }) => {
      const { commitId } = await checkpoints.capture({
        workspaceRoot: project,
        sessionId: 'workbench-session',
        checkpointId: 'run-base',
      })
      assert.ok(commitId)
      await writeFile(join(project, 'tracked.ts'), 'export const a = 2\nexport const b = 1\n', 'utf8')
      await writeFile(join(project, 'created.ts'), 'new\n', 'utf8')
      await store.capture({
        workspaceRoot: project,
        sessionId: 'workbench-session',
        recordId: 'run-base',
        baseCommitId: commitId,
      })
      const request = { workspaceRoot: project, sessionId: 'workbench-session', recordId: 'run-base' }

      const record = await store.read(request)
      assert.equal(record?.baseCommitId, commitId)
      // 项目是大仓里的子目录：按项目根相对路径读出改动前的全文。
      assert.deepEqual(await store.readBaseFile({ ...request, path: 'tracked.ts' }), {
        content: 'export const a = 1\nexport const b = 1\n',
      })
      // 这一轮新建的文件没有「改动前」；记录里没有的路径一律不读（renderer 指定不了任意文件）。
      assert.deepEqual(await store.readBaseFile({ ...request, path: 'created.ts' }), { content: null })
      assert.deepEqual(await store.readBaseFile({ ...request, path: 'removed.ts' }), { content: null })
      assert.deepEqual(await store.readBaseFile({ ...request, path: '../outside.txt' }), {
        content: null,
      })
      await assert.rejects(
        () =>
          checkpoints.readFileAtCommit({
            workspaceRoot: project,
            commitId,
            path: '../outside.txt',
            maxBytes: 1024,
          }),
        /无效的文件路径/u
      )
      assert.equal(
        await checkpoints.readFileAtCommit({
          workspaceRoot: project,
          commitId,
          path: 'tracked.ts',
          maxBytes: 8,
        }),
        null
      )
    })
  })

  void test('writes nothing for a run without changes and drops a whole session on removal', async () => {
    await withRepository(async ({ project, records, checkpoints, store }) => {
      const first = await checkpoints.capture({ workspaceRoot: project, sessionId: 's', checkpointId: 'a' })
      const quiet = await store.capture({
        workspaceRoot: project,
        sessionId: 's',
        recordId: 'a',
        baseCommitId: first.commitId!,
      })
      assert.equal(quiet.fileCount, 0)
      assert.equal(quiet.error, null)
      assert.deepEqual(await readdir(records), [])

      await writeFile(join(project, 'tracked.ts'), 'changed\n', 'utf8')
      await store.capture({ workspaceRoot: project, sessionId: 's', recordId: 'b', baseCommitId: first.commitId! })
      const [rootDirectory] = await readdir(records)
      assert.ok(rootDirectory)
      assert.equal(existsSync(join(records, rootDirectory, 's', 'b.json')), true)

      await store.delete({ workspaceRoot: project, sessionId: 's' })
      assert.equal(existsSync(join(records, rootDirectory, 's')), false)
    })
  })

  void test('re-captures a running round into the same record, in request order, and drops it once reverted', async () => {
    await withRepository(async ({ project, records, checkpoints }) => {
      let clock = 1_000
      const store = new WorkbenchChatRunChangeStore(checkpoints, () => records, () => (clock += 1))
      const { commitId } = await checkpoints.capture({
        workspaceRoot: project,
        sessionId: 's',
        checkpointId: 'run',
      })
      assert.ok(commitId)
      const request = { workspaceRoot: project, sessionId: 's', recordId: 'run', baseCommitId: commitId }

      // 运行中第一次采集：只改了一个文件。
      await writeFile(join(project, 'tracked.ts'), 'export const a = 2\nexport const b = 1\n', 'utf8')
      const first = await store.capture(request)
      assert.equal(first.fileCount, 1)

      // 又写了一个文件：实时采集与收尾的最终采集前后脚到达，同一条记录按到达顺序写，最终那次最后落地。
      await writeFile(join(project, 'created.ts'), 'new\n', 'utf8')
      const [live, final] = await Promise.all([store.capture(request), store.capture(request)])
      assert.equal(live.fileCount, 2)
      assert.equal(final.fileCount, 2)
      assert.ok(final.capturedAt > live.capturedAt)
      const [rootDirectory] = await readdir(records)
      assert.ok(rootDirectory)
      assert.deepEqual(await readdir(join(records, rootDirectory, 's')), ['run.json'])
      const record = await store.read(request)
      assert.equal(record?.capturedAt, final.capturedAt)
      assert.deepEqual(record?.changes.map((change) => change.path).sort(), ['created.ts', 'tracked.ts'])

      // 改动全被撤回：记录文件随之删掉，不留旧内容冒充现在。
      await writeFile(join(project, 'tracked.ts'), 'export const a = 1\nexport const b = 1\n', 'utf8')
      await unlink(join(project, 'created.ts'))
      const reverted = await store.capture(request)
      assert.deepEqual([reverted.fileCount, reverted.error], [0, null])
      assert.equal(await store.read(request), null)

      // 删除与采集排在同一条会话队列里：刚发出的采集写完之后才删，不会删了又被写回来。
      await writeFile(join(project, 'tracked.ts'), 'changed again\n', 'utf8')
      const capturing = store.capture(request)
      await store.delete({ workspaceRoot: project, sessionId: 's', recordIds: ['run'] })
      assert.equal((await capturing).fileCount, 1)
      assert.equal(await store.read(request), null)
    })
  })

  void test('reports a failed capture in the summary and rejects unsafe ids', async () => {
    await withRepository(async ({ project, store }) => {
      const failed = await store.capture({
        workspaceRoot: project,
        sessionId: 's',
        recordId: 'r',
        baseCommitId: '0'.repeat(40),
      })
      assert.equal(failed.fileCount, 0)
      assert.match(failed.error ?? '', /git diff/u)

      await assert.rejects(
        () => store.read({ workspaceRoot: project, sessionId: '../escape', recordId: 'r' }),
        /无效的会话或记录 id/u
      )
      await assert.rejects(
        () => store.delete({ workspaceRoot: 'relative/root', sessionId: 's' }),
        /工作区根目录无效/u
      )
    })
  })
})

/** 假的文件监听：测试自己决定什么时候冒出哪个路径的事件（真实写盘照做，事件由测试补发）。 */
function createFakeWatcher(): { source: WorkbenchRawPathSource; emit: (...paths: string[]) => void } {
  const observers = new Set<WorkbenchRawPathObserver>()
  return {
    source: {
      observeRawPaths: async (workspaceRoot, observer) => {
        observers.add(observer)
        return { workspaceRoot, stop: () => void observers.delete(observer) }
      },
    },
    emit: (...paths) => {
      for (const observer of [...observers]) for (const path of paths) observer.onPath(path)
    },
  }
}

interface AttributedFixture extends RepositoryFixture {
  indexes: string
  clock: { now: number }
  watcher: ReturnType<typeof createFakeWatcher>
  attribution: WorkbenchChatRunAttribution
  /** 接了改动归属的记录区（生产里的装配）。 */
  attributed: WorkbenchChatRunChangeStore
  /** 按假时钟写盘（改动时刻记在假时钟上）。 */
  write: (path: string, content: string | null) => Promise<void>
}

/**
 * 与假时钟对得上的改动时刻：经 {@link AttributedFixture.write} 写的记下当时的假时刻（写文件改它自己的，
 * 新建、删除改上级目录的，建出来的目录也一样）；没经它写过的在世路径算作远早于这一轮。
 */
function createFakeChangeTimes(root: string, clock: { now: number }) {
  const times = new Map<string, number>()
  return {
    read: async (absolutePath: string): Promise<number | null> =>
      existsSync(absolutePath) ? times.get(absolutePath) ?? 0 : null,
    write: async (path: string, content: string | null): Promise<void> => {
      const target = join(root, path)
      const existed = existsSync(target)
      const createdDirectories: string[] = []
      for (let directory = dirname(target); !existsSync(directory); directory = dirname(directory))
        createdDirectories.push(directory)
      await writeProjectFile(root, path, content)
      if (content !== null) times.set(target, clock.now)
      if (content === null || !existed) times.set(dirname(target), clock.now)
      for (const directory of createdDirectories) {
        times.set(directory, clock.now)
        times.set(dirname(directory), clock.now)
      }
    },
  }
}

async function withAttributedRepository(
  run: (fixture: AttributedFixture) => Promise<void>
): Promise<void> {
  const indexes = await mkdtemp(join(tmpdir(), 'workbench-run-attribution-indexes-'))
  try {
    await withRepository(async (fixture) => {
      const clock = { now: 1_757_000_000_000 }
      const watcher = createFakeWatcher()
      // 账本按真实路径读改动时刻：临时目录在 macOS 上经过 /var → /private/var 的符号链接。
      const changeTimes = createFakeChangeTimes(await realpath(fixture.project), clock)
      const checkpoints = new WorkbenchChatCheckpointService(() => indexes)
      const attribution = new WorkbenchChatRunAttribution(watcher.source, () => clock.now, changeTimes.read)
      const attributed = new WorkbenchChatRunChangeStore(
        checkpoints,
        () => fixture.records,
        () => clock.now,
        attribution
      )
      await run({
        ...fixture,
        checkpoints,
        indexes,
        clock,
        watcher,
        attribution,
        attributed,
        write: changeTimes.write,
      })
    })
  } finally {
    await rm(indexes, { recursive: true, force: true })
  }
}

async function writeProjectFile(project: string, path: string, content: string | null): Promise<void> {
  const target = join(project, path)
  if (content === null) {
    await unlink(target)
    return
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

/** 开一轮：拍检查点（同时开账），交回这一轮 Agent 的上报口与采集请求。 */
async function startRound(fixture: AttributedFixture, recordId: string) {
  const { commitId } = await fixture.attributed.captureCheckpoint({
    workspaceRoot: fixture.project,
    sessionId: 's',
    checkpointId: recordId,
  })
  assert.ok(commitId)
  const activity = fixture.attribution.activityFor({ projectRoot: fixture.project, sessionId: 's' })
  const request = { workspaceRoot: fixture.project, sessionId: 's', recordId, baseCommitId: commitId }
  return {
    commitId,
    request,
    /** Agent 的写文件工具：落盘、监听回声、报告改过的路径。 */
    agentWrite: async (files: Record<string, string | null>): Promise<void> => {
      const finish = activity.beginFileWrite()
      for (const [path, content] of Object.entries(files)) await fixture.write(path, content)
      fixture.watcher.emit(...Object.keys(files))
      finish(Object.keys(files))
    },
    /** Agent 的命令：命令跑着时写出来的文件。 */
    agentCommand: async (files: Record<string, string | null>): Promise<void> => {
      const end = activity.beginCommand()
      for (const [path, content] of Object.entries(files)) await fixture.write(path, content)
      fixture.watcher.emit(...Object.keys(files))
      end()
    },
    activity: activity satisfies WorkbenchAgentProjectActivityPort,
  }
}

/** 用户在外部编辑器 / 终端里改文件：只有监听看得到。 */
async function editOutside(fixture: AttributedFixture, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) await fixture.write(path, content)
  fixture.watcher.emit(...Object.keys(files))
}

/** 用户在 Workbench 编辑器里保存：保存口明确报是用户。 */
async function saveInEditor(fixture: AttributedFixture, path: string, content: string): Promise<void> {
  await fixture.write(path, content)
  fixture.watcher.emit(path)
  fixture.attribution.recordUserWrites({ workspaceRoot: fixture.project, paths: [path] })
}

/** 让时钟走过写入回声与命令余量，后面的事件不再被算作前面那次动作的。 */
function passTime(fixture: AttributedFixture): void {
  fixture.clock.now += AgentCommandGraceMs * 5
}

void describe('Workbench chat run changes attributed to the agent', () => {
  void test('a round lists only what the agent changed and marks files also edited outside the AI', async () => {
    await withAttributedRepository(async (fixture) => {
      const { project, attributed, records } = fixture
      await writeProjectFile(project, 'mixed.ts', 'base\n')
      const round = await startRound(fixture, 'run-1')

      await round.agentWrite({ 'tracked.ts': 'export const a = 2\nexport const b = 1\n', 'created.ts': 'new\n', 'removed.ts': null })
      passTime(fixture)
      await round.agentCommand({ 'generated/out.txt': 'built\n' })
      passTime(fixture)
      // 运行期间用户自己改的：外部编辑器里新建一个文件，Workbench 编辑器里又保存了 Agent 也改过的 mixed.ts。
      await editOutside(fixture, { 'user.ts': 'mine\n' })
      await round.agentWrite({ 'mixed.ts': 'agent\n' })
      passTime(fixture)
      await saveInEditor(fixture, 'mixed.ts', 'agent\nand mine\n')

      const summary = await attributed.capture({ ...round.request, final: true })
      assert.deepEqual(
        { fileCount: summary.fileCount, error: summary.error },
        { fileCount: 5, error: null }
      )
      // 摘要带着卡片上列的那些文件：回溯确认框按它同步数出改了几个文件。
      assert.deepEqual(
        [...(summary.paths ?? [])].sort(),
        ['created.ts', 'generated/out.txt', 'mixed.ts', 'removed.ts', 'tracked.ts']
      )
      const record = await attributed.read(round.request)
      assert.ok(record)
      assert.deepEqual(
        Object.fromEntries(record.changes.map((change) => [change.path, [change.status, change.attribution]])),
        {
          'created.ts': ['added', 'agent'],
          'generated/out.txt': ['added', 'agent'],
          'mixed.ts': ['modified', 'mixed'],
          'removed.ts': ['deleted', 'agent'],
          'tracked.ts': ['modified', 'agent'],
        }
      )
      // 快照里的对象 id 只留在主进程的记录文件里，不交给 renderer。
      assert.equal(record.changes.some((change) => 'before' in change || 'after' in change), false)
      const [rootDirectory] = await readdir(records)
      const stored = JSON.parse(await readFile(join(records, rootDirectory!, 's', 'run-1.json'), 'utf8'))
      assert.deepEqual(stored.attribution, { watcher: 'observed' })
      assert.match(stored.changes.find((change: { path: string }) => change.path === 'tracked.ts').before.oid, /^[0-9a-f]{40}$/u)

      // 最终采集之后账本关掉：再采认不出谁改的，不把用户后来的改动记成这一轮的，也不动已经落定的记录。
      await editOutside(fixture, { 'after-run.ts': 'later\n' })
      const late = await attributed.capture(round.request)
      assert.deepEqual([late.fileCount, late.capturedAt], [5, summary.capturedAt])
      assert.equal((await attributed.read(round.request))?.changes.length, 5)
    })
  })

  void test('rewind puts back only the agent’s files and keeps files edited outside the AI', async () => {
    await withAttributedRepository(async (fixture) => {
      const { repo, project, attributed } = fixture
      await writeProjectFile(project, 'notes.ts', 'notes\n')
      await writeProjectFile(project, 'between.ts', 'between\n')
      await writeProjectFile(project, 'later.ts', 'later\n')
      await writeProjectFile(project, 'mixed.ts', 'mixed\n')
      const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).trim()

      // 第一轮：Agent 改、建、删；运行期间用户改了 notes.ts；mixed.ts 两边都改了。
      const first = await startRound(fixture, 'run-1')
      await first.agentWrite({
        'tracked.ts': 'export const a = 2\nexport const b = 1\n',
        'deep/new/created.ts': 'new\n',
        'removed.ts': null,
        'between.ts': 'between by agent\n',
        'mixed.ts': 'mixed by agent\n',
      })
      passTime(fixture)
      await editOutside(fixture, { 'notes.ts': 'notes by user\n', 'mixed.ts': 'mixed by agent and user\n' })
      await attributed.capture({ ...first.request, final: true })

      // 两轮之间用户改了 between.ts。
      await writeProjectFile(project, 'between.ts', 'between by user\n')

      // 第二轮：Agent 接着改 tracked.ts、between.ts，又改了 later.ts。
      passTime(fixture)
      const second = await startRound(fixture, 'run-2')
      await second.agentWrite({
        'tracked.ts': 'export const a = 3\nexport const b = 1\n',
        'between.ts': 'between by user, then agent\n',
        'later.ts': 'later by agent\n',
      })
      await attributed.capture({ ...second.request, final: true })

      // 这一轮收尾之后用户又改了 later.ts。
      await writeProjectFile(project, 'later.ts', 'later by agent, then user\n')

      const result = await attributed.rewind({
        workspaceRoot: project,
        sessionId: 's',
        commitId: first.commitId,
        recordIds: ['run-1', 'run-2'],
      })
      assert.deepEqual(
        { ...result, restoredPaths: [...result.restoredPaths].sort() },
        {
          restored: true,
          error: null,
          scope: 'agent-changes',
          restoredPaths: ['deep/new/created.ts', 'removed.ts', 'tracked.ts'],
          keptPaths: ['between.ts', 'later.ts', 'mixed.ts'],
        }
      )

      // Agent 的改动撤回：改过的回到原样，删掉的重建，新建的连同空出来的目录一起删掉。
      assert.equal(await readFile(join(project, 'tracked.ts'), 'utf8'), 'export const a = 1\nexport const b = 1\n')
      assert.equal(await readFile(join(project, 'removed.ts'), 'utf8'), 'bye\n')
      assert.equal(existsSync(join(project, 'deep')), false)
      // AI 之外的改动一个不少。
      assert.equal(await readFile(join(project, 'notes.ts'), 'utf8'), 'notes by user\n')
      assert.equal(await readFile(join(project, 'between.ts'), 'utf8'), 'between by user, then agent\n')
      assert.equal(await readFile(join(project, 'later.ts'), 'utf8'), 'later by agent, then user\n')
      assert.equal(await readFile(join(project, 'mixed.ts'), 'utf8'), 'mixed by agent and user\n')
      // 用户的分支与暂存区原样。
      assert.equal((await git(repo, ['rev-parse', 'HEAD'])).trim(), headBefore)
      assert.equal((await git(repo, ['diff', '--cached', '--name-only'])).trim(), '')
    })
  })

  void test('records written before attribution keep rewinding the whole checkpoint', async () => {
    await withAttributedRepository(async (fixture) => {
      const { project, checkpoints, records, attributed } = fixture
      // 旧版本写下的记录：没有归属，整个 diff 都在里面。
      const legacy = new WorkbenchChatRunChangeStore(checkpoints, () => records)
      const { commitId } = await checkpoints.capture({ workspaceRoot: project, sessionId: 's', checkpointId: 'old-run' })
      assert.ok(commitId)
      await writeProjectFile(project, 'tracked.ts', 'changed by agent\n')
      await writeProjectFile(project, 'user.ts', 'changed by user\n')
      await legacy.capture({ workspaceRoot: project, sessionId: 's', recordId: 'old-run', baseCommitId: commitId })

      const record = await attributed.read({ workspaceRoot: project, sessionId: 's', recordId: 'old-run' })
      assert.deepEqual(
        record?.changes.map((change) => [change.path, change.attribution]).sort(),
        [['tracked.ts', undefined], ['user.ts', undefined]]
      )

      const result = await attributed.rewind({
        workspaceRoot: project,
        sessionId: 's',
        commitId,
        recordIds: ['old-run'],
      })
      assert.deepEqual(result, {
        restored: true,
        error: null,
        scope: 'checkpoint',
        restoredPaths: [],
        keptPaths: [],
      })
      assert.equal(await readFile(join(project, 'tracked.ts'), 'utf8'), 'export const a = 1\nexport const b = 1\n')
      assert.equal(existsSync(join(project, 'user.ts')), false)
    })
  })

  void test('round changes and rewind stay attributed after the app restarts', async () => {
    await withAttributedRepository(async (fixture) => {
      const { project, records, indexes } = fixture
      await writeProjectFile(project, 'mixed.ts', 'base\n')
      const round = await startRound(fixture, 'run-1')
      await round.agentWrite({ 'tracked.ts': 'export const a = 2\nexport const b = 1\n', 'mixed.ts': 'agent\n' })
      passTime(fixture)
      await editOutside(fixture, { 'user.ts': 'mine\n', 'mixed.ts': 'agent and mine\n' })
      await fixture.attributed.capture({ ...round.request, final: true })

      // 重启：主进程里的账本、检查点服务与记录区全是新实例，只有数据区里的记录文件还在。
      const restarted = new WorkbenchChatRunChangeStore(
        new WorkbenchChatCheckpointService(() => indexes),
        () => records,
        Date.now,
        new WorkbenchChatRunAttribution(createFakeWatcher().source)
      )
      const record = await restarted.read(round.request)
      assert.deepEqual(
        record?.changes.map((change) => [change.path, change.attribution]).sort(),
        [['mixed.ts', 'mixed'], ['tracked.ts', 'agent']]
      )

      const result = await restarted.rewind({
        workspaceRoot: project,
        sessionId: 's',
        commitId: round.commitId,
        recordIds: ['run-1'],
      })
      assert.deepEqual(
        [result.scope, result.restoredPaths, result.keptPaths],
        ['agent-changes', ['tracked.ts'], ['mixed.ts']]
      )
      assert.equal(await readFile(join(project, 'tracked.ts'), 'utf8'), 'export const a = 1\nexport const b = 1\n')
      assert.equal(await readFile(join(project, 'mixed.ts'), 'utf8'), 'agent and mine\n')
      assert.equal(await readFile(join(project, 'user.ts'), 'utf8'), 'mine\n')
    })
  })

  void test('the final capture waits for the last command’s late writes', async () => {
    await withAttributedRepository(async (fixture) => {
      const { project, watcher } = fixture
      // 真实时钟：余量按真实时间走。
      const attribution = new WorkbenchChatRunAttribution(watcher.source)
      const store = new WorkbenchChatRunChangeStore(fixture.checkpoints, () => fixture.records, Date.now, attribution)
      const { commitId } = await store.captureCheckpoint({ workspaceRoot: project, sessionId: 's', checkpointId: 'run' })
      assert.ok(commitId)
      const request = { workspaceRoot: project, sessionId: 's', recordId: 'run', baseCommitId: commitId }

      attribution.activityFor({ projectRoot: project, sessionId: 's' }).beginCommand()()
      const capturing = store.capture({ ...request, final: true })
      // 命令已经返回，它的子进程过了一会儿才把文件写完。
      await delay(150)
      await writeProjectFile(project, 'late/output.txt', 'flushed late\n')
      watcher.emit('late/output.txt')

      const summary = await capturing
      assert.equal(summary.fileCount, 1)
      const record = await store.read(request)
      assert.deepEqual(record?.changes.map((change) => [change.path, change.attribution]), [
        ['late/output.txt', 'agent'],
      ])
    })
  }, 10_000)

  void test('when a change happened decides who made it, not when its watcher event arrives', async () => {
    await withAttributedRepository(async (fixture) => {
      const { project, watcher } = fixture
      // 真实时钟、真实的改动时刻（macOS 忙的时候文件事件要攒好几秒才到）。
      const attribution = new WorkbenchChatRunAttribution(watcher.source)
      const store = new WorkbenchChatRunChangeStore(fixture.checkpoints, () => fixture.records, Date.now, attribution)
      const { commitId } = await store.captureCheckpoint({ workspaceRoot: project, sessionId: 's', checkpointId: 'run' })
      assert.ok(commitId)
      const request = { workspaceRoot: project, sessionId: 's', recordId: 'run', baseCommitId: commitId }
      const activity = attribution.activityFor({ projectRoot: project, sessionId: 's' })

      // 用户在命令开跑前改了 notes.md，它的事件等命令跑起来才到。
      await writeProjectFile(project, 'notes.md', 'mine\n')
      await delay(120)
      const endCommand = activity.beginCommand()
      watcher.emit('notes.md')
      // 命令写出 build/out.txt、删掉 removed.ts：删除的事件一直没来，产物的事件在余量过去之后才到。
      await writeProjectFile(project, 'build/out.txt', 'built\n')
      await writeProjectFile(project, 'removed.ts', null)
      endCommand()
      await delay(AgentCommandGraceMs + 200)
      watcher.emit('build', 'build/out.txt')

      await store.capture({ ...request, final: true })
      const record = await store.read(request)
      assert.deepEqual(record?.changes.map((change) => [change.path, change.status, change.attribution]), [
        ['build/out.txt', 'added', 'agent'],
        ['removed.ts', 'deleted', 'agent'],
      ])
    })
  }, 10_000)

  void test('without a ledger nothing is attributed, and a folder that is not a repository opens none', async () => {
    await withAttributedRepository(async (fixture) => {
      const { project, checkpoints, attributed, records } = fixture
      const { commitId } = await checkpoints.capture({ workspaceRoot: project, sessionId: 's', checkpointId: 'unknown' })
      assert.ok(commitId)
      await writeProjectFile(project, 'tracked.ts', 'changed\n')
      const summary = await attributed.capture({
        workspaceRoot: project,
        sessionId: 's',
        recordId: 'unknown',
        baseCommitId: commitId,
      })
      assert.deepEqual([summary.fileCount, summary.error], [0, null])
      assert.deepEqual(await readdir(records), [])

      const plain = await mkdtemp(join(tmpdir(), 'workbench-run-attribution-plain-'))
      try {
        const opened = await attributed.captureCheckpoint({ workspaceRoot: plain, sessionId: 's', checkpointId: 'c' })
        assert.equal(opened.commitId, null)
        assert.equal(await fixture.attribution.resolve({ workspaceRoot: plain, sessionId: 's', recordId: 'c' }, ['a'], { final: true }), null)
      } finally {
        await rm(plain, { recursive: true, force: true })
      }
    })
  })
})
