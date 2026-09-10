import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { WorkbenchChatCheckpointService } from '../src/main/workspace/git/WorkbenchChatCheckpoints'
import { WorkbenchChatRunChangeStore } from '../src/main/workspace/git/WorkbenchChatRunChanges'

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
