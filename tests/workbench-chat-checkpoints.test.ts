import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
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
  void test('restores the working tree to a captured turn without touching the user index or HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-'))
    const indexes = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-indexes-'))
    const service = new WorkbenchChatCheckpointService(() => indexes)

    try {
      await git(root, ['init', '-q'])
      await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
      await writeFile(join(root, 'tracked.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(root, 'removed-later.ts'), 'keep me\n', 'utf8')
      await git(root, ['add', '-A'])
      await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
      const headBefore = (await git(root, ['rev-parse', 'HEAD'])).trim()
      await writeFile(join(root, 'untracked-before.ts'), 'draft\n', 'utf8')

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

      // 这一轮里 agent 改了、删了、也新建了文件；忽略目录里的东西不该被快照动到。
      await writeFile(join(root, 'tracked.ts'), 'export const a = 2\n', 'utf8')
      await unlink(join(root, 'removed-later.ts'))
      await writeFile(join(root, 'created-by-agent.ts'), 'new\n', 'utf8')
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await writeFile(join(root, 'node_modules', 'dep.js'), 'dep\n', 'utf8')

      assert.deepEqual(
        await service.restore({ workspaceRoot: root, commitId: commitId! }),
        { restored: true, error: null }
      )
      assert.equal(await readFile(join(root, 'tracked.ts'), 'utf8'), 'export const a = 1\n')
      assert.equal(await readFile(join(root, 'removed-later.ts'), 'utf8'), 'keep me\n')
      assert.equal(await readFile(join(root, 'untracked-before.ts'), 'utf8'), 'draft\n')
      assert.equal(existsSync(join(root, 'created-by-agent.ts')), false)
      assert.equal(await readFile(join(root, 'node_modules', 'dep.js'), 'utf8'), 'dep\n')
      // 用户的分支与暂存区原样：还原只动工作树。
      assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), headBefore)
      assert.equal((await git(root, ['diff', '--cached', '--name-only'])).trim(), '')

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

  void test('restores only the given paths, and leaves one that changed since untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-paths-'))
    const indexes = await mkdtemp(join(tmpdir(), 'workbench-checkpoint-indexes-'))
    const service = new WorkbenchChatCheckpointService(() => indexes)

    try {
      await git(root, ['init', '-q'])
      await writeFile(join(root, 'edited.ts'), 'before\n', 'utf8')
      await writeFile(join(root, 'deleted.ts'), 'keep me\n', 'utf8')
      await writeFile(join(root, 'touched-later.ts'), 'before\n', 'utf8')
      await writeFile(join(root, 'bystander.ts'), 'before\n', 'utf8')
      await git(root, ['add', '-A'])
      await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
      const headBefore = (await git(root, ['rev-parse', 'HEAD'])).trim()
      const { commitId } = await service.capture({ workspaceRoot: root, sessionId: 's', checkpointId: 'c' })
      assert.ok(commitId)

      await writeFile(join(root, 'edited.ts'), 'after\n', 'utf8')
      await unlink(join(root, 'deleted.ts'))
      await mkdir(join(root, 'fresh', 'dir'), { recursive: true })
      await writeFile(join(root, 'fresh', 'dir', 'created.ts'), 'new\n', 'utf8')
      await writeFile(join(root, 'touched-later.ts'), 'after\n', 'utf8')
      await writeFile(join(root, 'bystander.ts'), 'someone else\n', 'utf8')
      const changes = await service.diffWorkingTree({
        workspaceRoot: root,
        baseCommitId: commitId!,
        tree: await service.snapshotWorkingTree(root),
      })
      const byPath = new Map(changes.map((change) => [change.path, change]))
      assert.equal(byPath.get('fresh/dir/created.ts')?.before, null)
      assert.equal(byPath.get('deleted.ts')?.after, null)
      // 采集之后又被别人改过：此刻已不是期望的样子。
      await writeFile(join(root, 'touched-later.ts'), 'after, then user\n', 'utf8')

      const restores = ['edited.ts', 'deleted.ts', 'fresh/dir/created.ts', 'touched-later.ts'].map((path) => ({
        path,
        expected: byPath.get(path)!.after,
        target: byPath.get(path)!.before,
      }))
      const result = await service.restorePaths({ workspaceRoot: root, paths: restores })
      assert.deepEqual(
        { ...result, restoredPaths: [...result.restoredPaths].sort() },
        {
          restored: true,
          error: null,
          restoredPaths: ['deleted.ts', 'edited.ts', 'fresh/dir/created.ts'],
          changedSince: ['touched-later.ts'],
        }
      )
      assert.equal(await readFile(join(root, 'edited.ts'), 'utf8'), 'before\n')
      assert.equal(await readFile(join(root, 'deleted.ts'), 'utf8'), 'keep me\n')
      assert.equal(existsSync(join(root, 'fresh')), false)
      assert.equal(await readFile(join(root, 'touched-later.ts'), 'utf8'), 'after, then user\n')
      assert.equal(await readFile(join(root, 'bystander.ts'), 'utf8'), 'someone else\n')
      assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), headBefore)
      assert.equal((await git(root, ['diff', '--cached', '--name-only'])).trim(), '')

      // 已经是目标样子的路径不算撤回；路径越出项目根直接拒绝。
      assert.deepEqual(
        await service.restorePaths({ workspaceRoot: root, paths: restores.slice(0, 1).map((item) => ({ ...item, expected: item.target })) }),
        { restored: true, error: null, restoredPaths: [], changedSince: [] }
      )
      await assert.rejects(
        () => service.restorePaths({ workspaceRoot: root, paths: [{ path: '../escape.ts', expected: null, target: null }] }),
        /无效的文件路径/u
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(indexes, { recursive: true, force: true })
    }
  })

  void test('falls back to conversation-only checkpoints outside a git repository', async () => {
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
        () => service.restore({ workspaceRoot: root, commitId: 'not-a-commit' }),
        /无效的检查点提交/u
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(indexes, { recursive: true, force: true })
    }
  })
})
