import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, setDefaultTimeout, test } from 'bun:test'

import { parseWorkbenchGitCommitDiff } from '../src/renderer/src/models/git/changesPanel.model'

import {
  commitAll,
  createGitService,
  entryCodes,
  git,
  isAppError,
  porcelain,
  withRepository,
} from './helpers/gitRepository'

// 一个场景会启动多次真实 Git；Windows CI 上五秒不足以完成冲突与回滚的整条流程。
setDefaultTimeout(30_000)

/** 一个有基础提交的仓库：tracked.txt 与 other.txt 都已提交。 */
async function withBaseRepository(run: (root: string) => Promise<void>): Promise<void> {
  await withRepository(async (root) => {
    await writeFile(join(root, 'tracked.txt'), 'base\n')
    await writeFile(join(root, 'other.txt'), 'base\n')
    await commitAll(root, 'base')
    await run(root)
  })
}

void describe('Workbench Git stash', () => {
  void test('stashes tracked changes with a message and leaves untracked files alone', async () => {
    await withBaseRepository(async (root) => {
      await writeFile(join(root, 'tracked.txt'), 'edited\n')
      await writeFile(join(root, 'staged.txt'), 'staged\n')
      await git(root, ['add', 'staged.txt'])
      await writeFile(join(root, '草稿.txt'), 'untracked\n')

      const service = createGitService()
      assert.deepEqual((await service.listStashes(root)).stashes, [])
      const stashed = await service.stash(root, { message: '  半成品：登录页  ' })
      assert.equal(stashed.stash.message, '半成品：登录页')
      assert.equal(stashed.stash.autoMessage, false)
      assert.equal(stashed.stash.branch, 'main')
      assert.equal(stashed.stash.index, 0)
      assert.equal(stashed.stash.includesUntracked, false)
      assert.match(stashed.stash.sha, /^[0-9a-f]{40}$/u)
      assert.ok(Math.abs(stashed.stash.createdAt - Date.now()) < 60_000)
      assert.deepEqual(stashed.stashes, [stashed.stash])
      // 没勾「包含未跟踪的文件」：它原样留在工作区里。
      assert.deepEqual(entryCodes(stashed.summary), ['?? 草稿.txt'])
      assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'base\n')
      assert.equal(existsSync(join(root, 'staged.txt')), false)

      const listed = await service.listStashes(root)
      assert.deepEqual(listed.stashes, [stashed.stash])
    })
  })

  void test('a stash can take untracked files along, and its diff lists them by their real names', async () => {
    await withBaseRepository(async (root) => {
      await writeFile(join(root, '.gitignore'), 'ignored.log\n')
      await commitAll(root, 'ignore logs')
      await writeFile(join(root, 'tracked.txt'), 'edited\n')
      await mkdir(join(root, '文档'))
      await writeFile(join(root, '文档', '新 文件.md'), '新的\n')
      await writeFile(join(root, 'ignored.log'), 'ignored\n')

      const service = createGitService()
      const stashed = await service.stash(root, { includeUntracked: true })
      assert.equal(stashed.stash.includesUntracked, true)
      // 没写说明：git 拿它基于的提交当说明。
      assert.equal(stashed.stash.autoMessage, true)
      assert.match(stashed.stash.message, /^[0-9a-f]{7,} ignore logs$/u)
      assert.equal(stashed.summary.status?.isClean, true)
      assert.equal(existsSync(join(root, '文档', '新 文件.md')), false)
      // 被忽略的文件不算未跟踪，不会被拿走。
      assert.equal(await readFile(join(root, 'ignored.log'), 'utf8'), 'ignored\n')

      const diff = await service.getDiff(root, { stashSha: stashed.stash.sha, maxChars: 100_000 })
      assert.equal(diff.scope, 'stash')
      const files = parseWorkbenchGitCommitDiff(diff.diff)
      assert.deepEqual(files.map((file) => file.path).sort(), ['tracked.txt', '文档/新 文件.md'])
      assert.match(diff.diff, /^-base$/mu)
      assert.match(diff.diff, /^\+edited$/mu)
      assert.match(diff.diff, /^\+新的$/mu)

      const single = await service.getDiff(root, {
        stashSha: stashed.stash.sha,
        path: '文档/新 文件.md',
      })
      assert.deepEqual(
        parseWorkbenchGitCommitDiff(single.diff).map((file) => file.path),
        ['文档/新 文件.md']
      )
    })
  })

  void test('there has to be something to stash', async () => {
    await withBaseRepository(async (root) => {
      const service = createGitService()
      await assert.rejects(service.stash(root), isAppError('VALIDATION', /没有可以贮藏的改动/))

      await writeFile(join(root, 'new.txt'), 'new\n')
      await assert.rejects(
        service.stash(root),
        isAppError('VALIDATION', /只有未跟踪的文件[\s\S]*包含未跟踪的文件/)
      )
      assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new\n')
      assert.equal((await service.stash(root, { includeUntracked: true })).stashes.length, 1)
    })
  })

  void test('apply keeps the stash, pop removes it, drop discards it, all by identity', async () => {
    await withBaseRepository(async (root) => {
      const service = createGitService()
      await writeFile(join(root, 'tracked.txt'), 'first\n')
      const first = (await service.stash(root, { message: 'first' })).stash
      await writeFile(join(root, 'other.txt'), 'second\n')
      const second = (await service.stash(root, { message: 'second' })).stash
      // 新贮藏排在前面：原先的序号往后挪了，身份（对象名）不变。
      const listed = (await service.listStashes(root)).stashes
      assert.deepEqual(
        listed.map((stash) => [stash.index, stash.message, stash.sha]),
        [
          [0, 'second', second.sha],
          [1, 'first', first.sha],
        ]
      )

      const applied = await service.performStashAction(root, first.sha, 'apply')
      assert.equal(applied.stashAction.kept, true)
      assert.deepEqual(applied.stashAction.conflicts, [])
      assert.equal(applied.stashes.length, 2)
      assert.deepEqual(entryCodes(applied.summary), [' M tracked.txt'])
      await git(root, ['checkout', '-q', '--', 'tracked.txt'])

      const popped = await service.performStashAction(root, first.sha, 'pop')
      assert.equal(popped.stashAction.kept, false)
      assert.equal(popped.stashAction.stash.message, 'first')
      assert.deepEqual(
        popped.stashes.map((stash) => stash.message),
        ['second']
      )
      assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'first\n')

      const dropped = await service.performStashAction(root, second.sha, 'drop')
      assert.equal(dropped.stashAction.kept, false)
      assert.deepEqual(dropped.stashes, [])
      assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'base\n')

      // 已经不在的贮藏、不是对象名的东西：说清楚，不碰别的贮藏。
      await assert.rejects(
        service.performStashAction(root, second.sha, 'pop'),
        isAppError('VALIDATION', /这条贮藏已经不在了/)
      )
      await assert.rejects(
        service.performStashAction(root, 'stash@{0}', 'drop'),
        isAppError('VALIDATION', /这条贮藏已经不在了|无效/)
      )
      await assert.rejects(
        service.getDiff(root, { stashSha: second.sha }),
        isAppError('VALIDATION', /这条贮藏已经不在了/)
      )
    })
  })

  void test('a pop that conflicts hands the files to the conflict flow and keeps the stash', async () => {
    await withBaseRepository(async (root) => {
      const service = createGitService()
      await writeFile(join(root, 'tracked.txt'), 'stashed\n')
      const stash = (await service.stash(root, { message: 'conflicting' })).stash
      await writeFile(join(root, 'tracked.txt'), 'committed since\n')
      await commitAll(root, 'edit the same line')

      const popped = await service.performStashAction(root, stash.sha, 'pop')
      assert.deepEqual(popped.stashAction.conflicts, ['tracked.txt'])
      assert.equal(popped.stashAction.kept, true)
      assert.equal(popped.stashes.length, 1)
      assert.deepEqual(entryCodes(popped.summary), ['UU tracked.txt'])
      assert.match(await readFile(join(root, 'tracked.txt'), 'utf8'), /^<<<<<<< /mu)
      // 冲突还没解决时不能再取别的贮藏。
      await assert.rejects(
        service.performStashAction(root, stash.sha, 'apply'),
        isAppError('VALIDATION', /还有未解决的合并冲突/)
      )

      // 现有的冲突流程接着走：解决、标记为已解决；贮藏还在，用完自己删。
      await writeFile(join(root, 'tracked.txt'), 'resolved\n')
      const resolved = await service.performFileAction(root, ['tracked.txt'], 'resolve')
      assert.equal(resolved.fileAction.status.conflictedFiles, 0)
      assert.deepEqual((await service.performStashAction(root, stash.sha, 'drop')).stashes, [])
    })
  })

  void test('a stash that would overwrite local work is refused with what git said, touching nothing', async () => {
    await withBaseRepository(async (root) => {
      const service = createGitService()
      await writeFile(join(root, 'tracked.txt'), 'stashed\n')
      await writeFile(join(root, 'scratch.txt'), 'stashed untracked\n')
      const stash = (await service.stash(root, { includeUntracked: true })).stash

      // 工作区里同一个文件又有了没提交的改动：不覆盖它。git 自己这时照样会把贮藏里的未跟踪文件放回去，
      // 留下取回一半的工作区；这里动手之前就拦下，一点都不动。
      await writeFile(join(root, 'tracked.txt'), 'local edit\n')
      for (const action of ['pop', 'apply'] as const)
        await assert.rejects(
          service.performStashAction(root, stash.sha, action),
          isAppError('VALIDATION', /还有没提交的改动：tracked\.txt。/)
        )
      assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'local edit\n')
      assert.equal(existsSync(join(root, 'scratch.txt')), false)
      assert.equal((await service.listStashes(root)).stashes.length, 1)
      await git(root, ['checkout', '-q', '--', 'tracked.txt'])

      // 贮藏里的未跟踪文件在工作区里又出现了：同样不覆盖、不动（git 自己会先取回已跟踪的改动，撞上了才停）。
      await writeFile(join(root, 'scratch.txt'), 'written later\n')
      for (const action of ['pop', 'apply'] as const)
        await assert.rejects(
          service.performStashAction(root, stash.sha, action),
          isAppError('VALIDATION', /工作区里已经有同名的：scratch\.txt。/)
        )
      assert.equal(await readFile(join(root, 'scratch.txt'), 'utf8'), 'written later\n')
      assert.deepEqual(await porcelain(root), ['?? scratch.txt'])
      assert.equal((await service.listStashes(root)).stashes.length, 1)

      // 同名文件挪走之后就能取回了。
      await rm(join(root, 'scratch.txt'))
      const popped = await service.performStashAction(root, stash.sha, 'pop')
      assert.deepEqual(entryCodes(popped.summary), [' M tracked.txt', '?? scratch.txt'])
      assert.equal(await readFile(join(root, 'scratch.txt'), 'utf8'), 'stashed untracked\n')
    })
  })

  void test('a project nested in a repository stashes only its own files', async () => {
    await withRepository(async (repository) => {
      const project = join(repository, 'packages', 'app')
      await mkdir(project, { recursive: true })
      await writeFile(join(project, 'a.ts'), 'a\n')
      await writeFile(join(repository, 'root.ts'), 'root\n')
      await commitAll(repository, 'base')
      await writeFile(join(project, 'a.ts'), 'a\nedited\n')
      await writeFile(join(project, 'new.ts'), 'new\n')
      await writeFile(join(repository, 'root.ts'), 'root\nedited outside\n')

      const service = createGitService()
      const stashed = await service.stash(project, { includeUntracked: true })
      assert.equal(stashed.summary.status?.isClean, true)
      assert.deepEqual(await porcelain(repository), [' M root.ts'])
      assert.deepEqual(
        parseWorkbenchGitCommitDiff(
          (await service.getDiff(project, { stashSha: stashed.stash.sha })).diff
        )
          .map((file) => file.path)
          .sort(),
        ['packages/app/a.ts', 'packages/app/new.ts']
      )

      const popped = await service.performStashAction(project, stashed.stash.sha, 'pop')
      assert.deepEqual(entryCodes(popped.summary), [' M a.ts', '?? new.ts'])
    })
  })

  void test('stashing waits for a merge in progress and for unresolved conflicts', async () => {
    await withBaseRepository(async (root) => {
      await git(root, ['switch', '-q', '-c', 'feature'])
      await writeFile(join(root, 'tracked.txt'), 'feature\n')
      await commitAll(root, 'feature')
      await git(root, ['switch', '-q', 'main'])
      await writeFile(join(root, 'tracked.txt'), 'main\n')
      await commitAll(root, 'main')
      await assert.rejects(git(root, ['merge', 'feature']))

      const service = createGitService()
      await assert.rejects(
        service.stash(root, { message: 'mid-merge' }),
        isAppError('VALIDATION', /还有未解决的合并冲突/)
      )
      // 冲突解决了、合并还没提交：贮藏会把这次合并丢掉，也不做。
      await writeFile(join(root, 'tracked.txt'), 'resolved\n')
      await service.performFileAction(root, ['tracked.txt'], 'resolve')
      await assert.rejects(
        service.stash(root, { message: 'mid-merge' }),
        isAppError('VALIDATION', /正在合并/)
      )
      assert.ok((await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).trim())
    })
  })
})
