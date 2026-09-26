import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { WorkbenchChatCheckpointService } from '../src/main/workspace/git/WorkbenchChatCheckpoints'

const execFileAsync = promisify(execFile)

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root })
  return stdout
}

void describe('Workbench chat checkpoints', () => {
  void test('captures a turn under a private ref without touching the user index or HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-'))
    const indexes = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-indexes-'))
    const service = new WorkbenchChatCheckpointService(() => indexes)

    try {
      await git(root, ['init', '-q'])
      await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
      await writeFile(join(root, 'tracked.ts'), 'export const a = 1\n', 'utf8')
      await git(root, ['add', '-A'])
      await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
      const headBefore = (await git(root, ['rev-parse', 'HEAD'])).trim()
      await writeFile(join(root, 'untracked-before.ts'), 'draft\n', 'utf8')
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await writeFile(join(root, 'node_modules', 'dep.js'), 'dep\n', 'utf8')

      const { commitId } = await service.capture({
        workspaceRoot: root,
        sessionId: 'session 1',
        checkpointId: 'checkpoint/1',
        label: 'first turn',
      })
      assert.match(commitId ?? '', /^[0-9a-f]{40,64}$/u)
      assert.equal(
        (await git(root, ['rev-parse', 'refs/velaros/checkpoints/session-1/checkpoint-1'])).trim(),
        commitId
      )
      assert.equal((await git(root, ['log', '-1', '--format=%s', commitId!])).trim(), 'first turn')
      // 快照是整棵工作树（未跟踪的文件也在），忽略目录里的东西不进来。
      assert.deepEqual(
        (await git(root, ['ls-tree', '-r', '--name-only', commitId!])).trim().split('\n').sort(),
        ['.gitignore', 'tracked.ts', 'untracked-before.ts']
      )
      // 影子 index 另放一处：用户的分支、暂存区原样，未跟踪的文件仍是未跟踪。
      assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), headBefore)
      assert.equal((await git(root, ['diff', '--cached', '--name-only'])).trim(), '')
      assert.equal((await git(root, ['status', '--porcelain'])).trim(), '?? untracked-before.ts')

      await service.delete({
        workspaceRoot: root,
        sessionId: 'session 1',
        checkpointIds: ['checkpoint/1', 'never-existed'],
      })
      assert.equal(
        (await git(root, ['for-each-ref', 'refs/velaros/checkpoints'])).trim(),
        ''
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(indexes, { recursive: true, force: true })
    }
  })

  void test('diffs the working tree against a captured turn and reads files as they were', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-diff-'))
    const indexes = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-indexes-'))
    const service = new WorkbenchChatCheckpointService(() => indexes)

    try {
      await git(root, ['init', '-q'])
      await writeFile(join(root, 'edited.ts'), 'before\n', 'utf8')
      await writeFile(join(root, 'deleted.ts'), 'keep me\n', 'utf8')
      await writeFile(join(root, 'bystander.ts'), 'untouched\n', 'utf8')
      await git(root, ['add', '-A'])
      await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
      const { commitId } = await service.capture({ workspaceRoot: root, sessionId: 's', checkpointId: 'c' })
      assert.ok(commitId)

      await writeFile(join(root, 'edited.ts'), 'after\n', 'utf8')
      await unlink(join(root, 'deleted.ts'))
      await mkdir(join(root, 'fresh', 'dir'), { recursive: true })
      await writeFile(join(root, 'fresh', 'dir', 'created.ts'), 'new\n', 'utf8')
      const tree = await service.snapshotWorkingTree(root)
      assert.match(tree, /^[0-9a-f]{40,64}$/u)

      const changes = await service.diffWorkingTree({ workspaceRoot: root, baseCommitId: commitId, tree })
      assert.deepEqual(
        changes.map((change) => [change.path, change.status, change.additions, change.deletions]).sort(),
        [
          ['deleted.ts', 'deleted', 0, 1],
          ['edited.ts', 'modified', 1, 1],
          ['fresh/dir/created.ts', 'added', 1, 0],
        ]
      )
      const edited = changes.find((change) => change.path === 'edited.ts')
      assert.match(edited?.patch ?? '', /^-before$/mu)
      assert.match(edited?.patch ?? '', /^\+after$/mu)
      // 只剩逐文件的公开改动：没有回溯用的前后快照条目。
      assert.equal(changes.some((change) => 'before' in change || 'after' in change), false)

      // select 先筛出要留的文件，补丁只给留下的取。
      const selected = await service.diffWorkingTree({
        workspaceRoot: root,
        baseCommitId: commitId,
        tree,
        select: (listed) => listed.filter((change) => change.path === 'edited.ts'),
      })
      assert.deepEqual(selected, [edited])

      // 改动前的全文按检查点里的样子原样读出（结尾换行也在）；检查点里没有的文件为 null。
      const read = (path: string) =>
        service.readFileAtCommit({ workspaceRoot: root, commitId, path, maxBytes: 1024 })
      assert.equal(await read('deleted.ts'), 'keep me\n')
      assert.equal(await read('fresh/dir/created.ts'), null)
      await assert.rejects(() => read('../escape.ts'), /无效的文件路径/u)
      await assert.rejects(
        () => service.diffWorkingTree({ workspaceRoot: root, baseCommitId: 'HEAD', tree }),
        /无效的检查点提交/u
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(indexes, { recursive: true, force: true })
    }
  })

  void test('captures no checkpoint outside a git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-plain-'))
    const indexes = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-indexes-'))
    const service = new WorkbenchChatCheckpointService(() => indexes)

    try {
      await writeFile(join(root, 'notes.txt'), 'plain folder\n', 'utf8')
      assert.deepEqual(
        await service.capture({ workspaceRoot: root, sessionId: 's', checkpointId: 'c' }),
        { commitId: null }
      )
      await assert.rejects(
        () =>
          service.readFileAtCommit({
            workspaceRoot: root,
            commitId: 'not-a-commit',
            path: 'notes.txt',
            maxBytes: 1024,
          }),
        /无效的检查点提交/u
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(indexes, { recursive: true, force: true })
    }
  })
})
