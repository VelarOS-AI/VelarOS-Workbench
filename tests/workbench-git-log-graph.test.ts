import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { type WorkspaceGitLogEntry } from '../src/shared/contracts/system'

import { commitAll, createGitService, git, withRepository } from './helpers/gitRepository'

async function commitFile(root: string, file: string, subject: string): Promise<string> {
  await writeFile(join(root, file), `${subject}\n`)
  await commitAll(root, subject)
  return (await git(root, ['rev-parse', 'HEAD'])).trim()
}

function describeRefs(commit: WorkspaceGitLogEntry): string[] {
  return commit.refs.map((ref) => `${ref.kind}:${ref.name}${ref.current ? '*' : ''}`)
}

void describe('Workbench Git log for the commit graph', () => {
  void test('lists every local and remote branch by default, with parents and what points at each commit', async () => {
    await withRepository(async (root) => {
      const base = await commitFile(root, 'a.txt', 'base')
      await git(root, ['tag', 'v1.0'])
      await git(root, ['tag', '-a', 'release,1', '-m', 'annotated'])
      await git(root, ['switch', '-q', '-c', 'feature/login'])
      const feature = await commitFile(root, 'f.txt', 'feature work')
      // 一个只在远端有的分支：本地分支都到不了的提交。
      await git(root, ['switch', '-q', '-c', 'temp', base])
      const remoteOnly = await commitFile(root, 'r.txt', 'remote only')
      await git(root, ['update-ref', 'refs/remotes/origin/topic', remoteOnly])
      await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic'])
      await git(root, ['switch', '-q', 'main'])
      await git(root, ['branch', '-q', '-D', 'temp'])
      const main = await commitFile(root, 'm.txt', 'main work')
      // 不该出现在提交图里的：贮藏、AI 改动的影子检查点（都在别的引用下面）。
      await writeFile(join(root, 'a.txt'), 'stashed\n')
      await git(root, ['stash', '-q'])
      const orphan = (
        await git(root, ['commit-tree', `${main}^{tree}`, '-m', 'shadow checkpoint'])
      ).trim()
      await git(root, ['update-ref', 'refs/velaros/checkpoints/session/one', orphan])

      const log = await createGitService().getLog(root)
      assert.equal(log.hasMore, false)
      const bySubject = new Map(log.commits.map((commit) => [commit.subject, commit]))
      assert.deepEqual([...bySubject.keys()].sort(), [
        'base',
        'feature work',
        'main work',
        'remote only',
      ])
      assert.deepEqual(bySubject.get('main work')?.parents, [base])
      assert.deepEqual(bySubject.get('feature work')?.parents, [base])
      assert.deepEqual(bySubject.get('base')?.parents, [])
      assert.deepEqual(describeRefs(bySubject.get('main work')!), ['branch:main*'])
      assert.deepEqual(describeRefs(bySubject.get('feature work')!), ['branch:feature/login'])
      // 远端分支；`origin/HEAD` 这种指向别的分支的符号引用不算一个分支。
      assert.deepEqual(describeRefs(bySubject.get('remote only')!), ['remote:origin/topic'])
      assert.deepEqual(describeRefs(bySubject.get('base')!).sort(), ['tag:release,1', 'tag:v1.0'])
      assert.equal(bySubject.get('feature work')?.sha, feature)
      // 子提交排在父提交前面：提交图靠这个顺序。
      const order = log.commits.map((commit) => commit.sha)
      for (const commit of log.commits)
        for (const parent of commit.parents)
          assert.ok(order.indexOf(commit.sha) < order.indexOf(parent))
    })
  })

  void test('can be limited to one branch, and reads further pages on demand', async () => {
    await withRepository(async (root) => {
      const shas: string[] = []
      for (const subject of ['one', 'two', 'three', 'four', 'five'])
        shas.push(await commitFile(root, 'a.txt', subject))
      await git(root, ['switch', '-q', '-c', 'side', shas[1] ?? ''])
      await commitFile(root, 's.txt', 'side work')
      await git(root, ['switch', '-q', 'main'])

      const service = createGitService()
      const onlyMain = await service.getLog(root, { branch: 'main' })
      assert.deepEqual(
        onlyMain.commits.map((commit) => commit.subject),
        ['five', 'four', 'three', 'two', 'one']
      )
      assert.equal((await service.getLog(root)).commits.length, 6)

      const first = await service.getLog(root, { branch: 'main', limit: 2 })
      assert.deepEqual(
        first.commits.map((commit) => commit.subject),
        ['five', 'four']
      )
      assert.equal(first.hasMore, true)
      const second = await service.getLog(root, { branch: 'main', limit: 2, skip: 2 })
      assert.deepEqual(
        second.commits.map((commit) => commit.subject),
        ['three', 'two']
      )
      assert.equal(second.hasMore, true)
      const last = await service.getLog(root, { branch: 'main', limit: 2, skip: 4 })
      assert.deepEqual(
        last.commits.map((commit) => commit.subject),
        ['one']
      )
      assert.equal(last.hasMore, false)
    })
  })

  void test('a merge commit lists its parents mainline first; a detached HEAD is labelled as such', async () => {
    await withRepository(async (root) => {
      const base = await commitFile(root, 'a.txt', 'base')
      await git(root, ['switch', '-q', '-c', 'feature'])
      const feature = await commitFile(root, 'f.txt', 'feature')
      await git(root, ['switch', '-q', 'main'])
      const main = await commitFile(root, 'm.txt', 'main')
      await git(root, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])

      const service = createGitService()
      const merged = (await service.getLog(root)).commits[0]
      assert.equal(merged?.subject, 'merge feature')
      assert.deepEqual(merged?.parents, [main, feature])

      await git(root, ['checkout', '-q', '--detach', base])
      const detached = await service.getLog(root)
      const atBase = detached.commits.find((commit) => commit.sha === base)
      assert.deepEqual(describeRefs(atBase!), ['head:HEAD'])
      // 分离的 HEAD 上「全部分支」照样列得出各分支。
      assert.deepEqual(describeRefs(detached.commits[0]!), ['branch:main'])
    })
  })

  void test('a repository without commits has an empty log, not an error', async () => {
    await withRepository(async (root) => {
      const log = await createGitService().getLog(root)
      assert.deepEqual(log.commits, [])
      assert.equal(log.hasMore, false)
    })
  })
})
