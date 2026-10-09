import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import type { WorkbenchGitService } from '../src/main/workspace/git/WorkbenchGitService'

import {
  commitAll,
  createGitService,
  entryCodes,
  git,
  isAppError,
  withRepository,
} from './helpers/gitRepository'

async function commitFile(root: string, file: string, content: string, subject: string): Promise<string> {
  await writeFile(join(root, file), content)
  await commitAll(root, subject)
  return head(root)
}

async function head(root: string, revision = 'HEAD'): Promise<string> {
  return (await git(root, ['rev-parse', revision])).trim()
}

async function subjects(root: string, revision = 'HEAD'): Promise<string[]> {
  return (await git(root, ['log', '--format=%s', revision])).trim().split('\n')
}

async function parentCount(root: string, revision = 'HEAD'): Promise<number> {
  return (await git(root, ['rev-list', '--parents', '-n', '1', revision])).trim().split(' ').length - 1
}

interface Diverged {
  root: string
  service: WorkbenchGitService
  /** main 上的最新提交、feature 上的最新提交、两边的共同起点。 */
  main: string
  feature: string
  base: string
}

/**
 * main 与 feature 从同一个提交分出去。`conflict` 为 true 时两边都改了 shared.txt 的同一行；否则 feature
 * 只加了自己的文件。当前分支是 main。
 */
async function withDiverged(
  conflict: boolean,
  run: (repository: Diverged) => Promise<void>
): Promise<void> {
  await withRepository(async (root) => {
    const base = await commitFile(root, 'shared.txt', 'base\n', 'base')
    await git(root, ['switch', '-q', '-c', 'feature'])
    const feature = conflict
      ? await commitFile(root, 'shared.txt', 'feature\n', 'feature edit')
      : await commitFile(root, 'feature.txt', 'feature\n', 'feature work')
    await git(root, ['switch', '-q', 'main'])
    const main = conflict
      ? await commitFile(root, 'shared.txt', 'main\n', 'main edit')
      : await commitFile(root, 'main.txt', 'main\n', 'main work')
    await run({ root, service: createGitService(), main, feature, base })
  })
}

void describe('Workbench Git merge', () => {
  void test('merges a branch into the current one, and says so when there is nothing to merge', async () => {
    await withDiverged(false, async ({ root, service, main, feature }) => {
      const merged = await service.performOperation(root, { action: 'merge', target: 'feature' })
      assert.deepEqual(merged.operation.conflicts, [])
      assert.equal(merged.operation.upToDate, false)
      assert.equal(merged.summary.operation, null)
      assert.equal(merged.summary.status?.isClean, true)
      assert.deepEqual(
        (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1),
        [main, feature]
      )
      assert.equal(existsSync(join(root, 'feature.txt')), true)

      const again = await service.performOperation(root, { action: 'merge', target: 'feature' })
      assert.equal(again.operation.upToDate, true)
    })
  })

  void test('a branch given by its full ref name is the one merged, even with a tag of the same name', async () => {
    await withDiverged(false, async ({ root, service, main, feature }) => {
      const merged = await service.performOperation(root, {
        action: 'merge',
        target: 'refs/heads/feature',
      })
      assert.equal(merged.summary.operation, null)
      // 合并说明里写的是分支的短名字，不是完整的引用名。
      assert.equal((await subjects(root))[0], "Merge branch 'feature'")
      await git(root, ['reset', '-q', '--hard', main])

      // 标签 feature 指着别的提交：点的是分支，合并进来的就得是分支。
      await git(root, ['tag', 'feature', main])
      const again = await service.performOperation(root, {
        action: 'merge',
        target: 'refs/heads/feature',
      })
      assert.equal(again.operation.upToDate, false)
      assert.deepEqual(
        (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1),
        [main, feature]
      )
      assert.equal((await subjects(root))[0], "Merge branch 'heads/feature'")
    })
  })

  void test('a conflicting merge stops, is continued once resolved, and records the merge', async () => {
    await withDiverged(true, async ({ root, service, main, feature }) => {
      await writeFile(join(root, 'notes.txt'), 'untracked\n')
      const merged = await service.performOperation(root, { action: 'merge', target: 'feature' })
      assert.deepEqual(merged.operation.conflicts, ['shared.txt'])
      assert.deepEqual(merged.summary.operation, {
        kind: 'merge',
        step: null,
        total: null,
        detail: "Merge branch 'feature'",
      })
      assert.deepEqual(entryCodes(merged.summary), ['UU shared.txt', '?? notes.txt'])

      // 冲突没解决完不能继续；另起一个操作也不行。
      await assert.rejects(
        service.performOperation(root, { action: 'continue' }),
        isAppError('VALIDATION', /“shared\.txt”还有未解决的合并冲突/)
      )
      await assert.rejects(
        service.performOperation(root, { action: 'cherry-pick', target: feature }),
        isAppError('VALIDATION', /正在合并/)
      )
      await assert.rejects(
        service.performOperation(root, { action: 'skip' }),
        isAppError('VALIDATION', /合并不能跳过/)
      )

      await writeFile(join(root, 'shared.txt'), 'both\n')
      await service.performFileAction(root, ['shared.txt'], 'resolve')
      const continued = await service.performOperation(root, { action: 'continue' })
      assert.deepEqual(continued.operation.conflicts, [])
      assert.equal(continued.summary.operation, null)
      assert.deepEqual(
        (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1),
        [main, feature]
      )
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'both\n')
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'untracked\n')
    })
  })

  void test('aborting a merge goes back to where it started and keeps untracked files', async () => {
    await withDiverged(true, async ({ root, service, main }) => {
      await writeFile(join(root, 'notes.txt'), 'untracked\n')
      await service.performOperation(root, { action: 'merge', target: 'feature' })
      const aborted = await service.performOperation(root, { action: 'abort' })
      assert.equal(aborted.summary.operation, null)
      assert.deepEqual(entryCodes(aborted.summary), ['?? notes.txt'])
      assert.equal(await head(root), main)
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'main\n')
      assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'untracked\n')

      for (const action of ['continue', 'abort', 'skip'] as const)
        await assert.rejects(
          service.performOperation(root, { action }),
          isAppError('VALIDATION', /没有进行到一半的/)
        )
    })
  })

  void test('a merge that would overwrite local work is refused in git\'s words and changes nothing', async () => {
    await withDiverged(false, async ({ root, service, main }) => {
      // feature 新增了 feature.txt；工作区里有个同名的未跟踪文件。
      await writeFile(join(root, 'feature.txt'), 'mine, untracked\n')
      await assert.rejects(
        service.performOperation(root, { action: 'merge', target: 'feature' }),
        isAppError('VALIDATION', /Git 没有开始合并[\s\S]*feature\.txt/)
      )
      assert.equal(await head(root), main)
      assert.equal(await readFile(join(root, 'feature.txt'), 'utf8'), 'mine, untracked\n')
      assert.equal((await service.getSummary(root)).operation, null)

      await assert.rejects(
        service.performOperation(root, { action: 'merge', target: 'no-such-branch' }),
        isAppError('VALIDATION', /找不到 no-such-branch/)
      )
      await assert.rejects(
        service.performOperation(root, { action: 'merge', target: '--abort' }),
        isAppError('VALIDATION', /无效/)
      )
      await assert.rejects(
        service.performOperation(root, { action: 'merge' }),
        isAppError('VALIDATION', /没有指明/)
      )
    })
  })
})

void describe('Workbench Git rebase', () => {
  void test('rebases the current branch onto another one', async () => {
    await withDiverged(false, async ({ root, service, main }) => {
      await git(root, ['switch', '-q', 'feature'])
      const rebased = await service.performOperation(root, { action: 'rebase', target: 'main' })
      assert.deepEqual(rebased.operation.conflicts, [])
      assert.equal(rebased.summary.operation, null)
      assert.equal(rebased.summary.status?.branch, 'feature')
      assert.deepEqual(await subjects(root), ['feature work', 'main work', 'base'])
      assert.equal(await head(root, 'HEAD~1'), main)

      const again = await service.performOperation(root, { action: 'rebase', target: 'main' })
      assert.equal(again.operation.upToDate, true)
    })
  })

  void test('a conflicting rebase stops with its progress, and continues after each conflict', async () => {
    await withDiverged(true, async ({ root, service }) => {
      await git(root, ['switch', '-q', 'feature'])
      await commitFile(root, 'later.txt', 'later\n', 'feature follow-up')
      const stopped = await service.performOperation(root, { action: 'rebase', target: 'main' })
      assert.deepEqual(stopped.operation.conflicts, ['shared.txt'])
      assert.deepEqual(stopped.summary.operation, {
        kind: 'rebase',
        step: 1,
        total: 2,
        detail: 'feature',
      })
      // 变基停着的时候 HEAD 是分离的。
      assert.equal(stopped.summary.status?.branch, null)
      // 变基中不在这里提交。
      await assert.rejects(
        service.commit(root, 'en-US', 'x'),
        isAppError('VALIDATION', /正在变基/)
      )

      await writeFile(join(root, 'shared.txt'), 'rebased\n')
      await service.performFileAction(root, ['shared.txt'], 'resolve')
      const continued = await service.performOperation(root, { action: 'continue' })
      assert.deepEqual(continued.operation.conflicts, [])
      assert.equal(continued.summary.operation, null)
      assert.equal(continued.summary.status?.branch, 'feature')
      assert.deepEqual(await subjects(root), [
        'feature follow-up',
        'feature edit',
        'main edit',
        'base',
      ])
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'rebased\n')
    })
  })

  void test('skip drops the commit the rebase stopped at; abort restores the branch', async () => {
    await withDiverged(true, async ({ root, service, feature }) => {
      await git(root, ['switch', '-q', 'feature'])
      await commitFile(root, 'later.txt', 'later\n', 'feature follow-up')
      const tip = await head(root)

      await service.performOperation(root, { action: 'rebase', target: 'main' })
      const aborted = await service.performOperation(root, { action: 'abort' })
      assert.equal(aborted.summary.operation, null)
      assert.equal(aborted.summary.status?.branch, 'feature')
      assert.equal(await head(root), tip)
      assert.equal(await head(root, 'HEAD~1'), feature)

      await service.performOperation(root, { action: 'rebase', target: 'main' })
      const skipped = await service.performOperation(root, { action: 'skip' })
      assert.equal(skipped.summary.operation, null)
      // 冲突的那个提交跳过了：main 的内容留着，后面的提交照样接上。
      assert.deepEqual(await subjects(root), ['feature follow-up', 'main edit', 'base'])
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'main\n')
    })
  })

  void test('a rebase over uncommitted changes is refused before anything moves', async () => {
    await withDiverged(false, async ({ root, service, feature }) => {
      await git(root, ['switch', '-q', 'feature'])
      await writeFile(join(root, 'feature.txt'), 'edited, not committed\n')
      await assert.rejects(
        service.performOperation(root, { action: 'rebase', target: 'main' }),
        isAppError('VALIDATION', /Git 没有开始变基/)
      )
      assert.equal(await head(root), feature)
      assert.equal(await readFile(join(root, 'feature.txt'), 'utf8'), 'edited, not committed\n')
      assert.equal((await service.getSummary(root)).operation, null)
    })
  })
})

void describe('Workbench Git cherry-pick and revert', () => {
  void test('cherry-picks a commit onto the current branch', async () => {
    await withDiverged(false, async ({ root, service, main, feature }) => {
      const picked = await service.performOperation(root, { action: 'cherry-pick', target: feature })
      assert.deepEqual(picked.operation.conflicts, [])
      assert.equal(picked.summary.operation, null)
      assert.deepEqual(await subjects(root), ['feature work', 'main work', 'base'])
      assert.equal(await head(root, 'HEAD~1'), main)
      assert.equal(await readFile(join(root, 'feature.txt'), 'utf8'), 'feature\n')

      // 同一个提交再拣选一次：改动已经有了，什么都不留下。
      await assert.rejects(
        service.performOperation(root, { action: 'cherry-pick', target: feature }),
        isAppError('VALIDATION', /改动当前分支里已经有了/)
      )
      assert.equal((await service.getSummary(root)).operation, null)
      assert.equal((await service.getSummary(root)).status?.isClean, true)
    })
  })

  // 创建仓库并依次验证冲突的多条恢复路径，Windows 原生 Git 启动需要更长时间。
  void test('a conflicting cherry-pick can be continued, skipped or aborted', async () => {
    await withDiverged(true, async ({ root, service, main, feature }) => {
      const stopped = await service.performOperation(root, { action: 'cherry-pick', target: feature })
      assert.deepEqual(stopped.operation.conflicts, ['shared.txt'])
      assert.deepEqual(stopped.summary.operation, {
        kind: 'cherry-pick',
        step: null,
        total: null,
        detail: feature.slice(0, 7),
      })
      const aborted = await service.performOperation(root, { action: 'abort' })
      assert.equal(aborted.summary.operation, null)
      assert.equal(await head(root), main)
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'main\n')

      await service.performOperation(root, { action: 'cherry-pick', target: feature })
      const skipped = await service.performOperation(root, { action: 'skip' })
      assert.equal(skipped.summary.operation, null)
      assert.equal(await head(root), main)

      await service.performOperation(root, { action: 'cherry-pick', target: feature })
      await writeFile(join(root, 'shared.txt'), 'picked\n')
      await service.performFileAction(root, ['shared.txt'], 'resolve')
      const continued = await service.performOperation(root, { action: 'continue' })
      assert.equal(continued.summary.operation, null)
      assert.deepEqual(await subjects(root), ['feature edit', 'main edit', 'base'])
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'picked\n')
    })
  }, 30_000)

  void test('reverts a commit with a new commit, a merge commit against its mainline', async () => {
    await withDiverged(false, async ({ root, service, main }) => {
      const reverted = await service.performOperation(root, { action: 'revert', target: main })
      assert.deepEqual(reverted.operation.conflicts, [])
      assert.equal(reverted.summary.operation, null)
      assert.equal((await subjects(root))[0], 'Revert "main work"')
      assert.equal(existsSync(join(root, 'main.txt')), false)

      // 撤销一个合并提交：撤掉的是它合并进来的那些改动（相对第一个父提交）。
      await service.performOperation(root, { action: 'merge', target: 'feature' })
      assert.equal(await parentCount(root), 2)
      const merge = await head(root)
      await service.performOperation(root, { action: 'revert', target: merge })
      assert.equal(existsSync(join(root, 'feature.txt')), false)
      assert.match((await subjects(root))[0] ?? '', /^Revert "Merge branch 'feature'/)
      // 拣选一个合并提交也按第一个父提交算它带来的改动。
      const picked = await service.performOperation(root, { action: 'cherry-pick', target: merge })
      assert.equal(picked.summary.operation, null)
      assert.equal(existsSync(join(root, 'feature.txt')), true)
    })
  })

  void test('a conflicting revert stops as a revert in progress and can be aborted', async () => {
    await withRepository(async (root) => {
      await commitFile(root, 'a.txt', 'one\n', 'one')
      const second = await commitFile(root, 'a.txt', 'two\n', 'two')
      const third = await commitFile(root, 'a.txt', 'three\n', 'three')
      const service = createGitService()

      const stopped = await service.performOperation(root, { action: 'revert', target: second })
      assert.deepEqual(stopped.operation.conflicts, ['a.txt'])
      assert.equal(stopped.summary.operation?.kind, 'revert')
      assert.equal(stopped.summary.operation?.detail, second.slice(0, 7))
      const aborted = await service.performOperation(root, { action: 'abort' })
      assert.equal(aborted.summary.operation, null)
      assert.equal(await head(root), third)

      // 解决之后提交（提交面板的提交按钮）也能完成这次撤销。
      await service.performOperation(root, { action: 'revert', target: second })
      await writeFile(join(root, 'a.txt'), 'one and three\n')
      await service.performFileAction(root, ['a.txt'], 'resolve')
      const committed = await service.commitStaged(root, 'en-US')
      assert.match(committed.commit.message, /^Revert "two"/)
      assert.equal(committed.summary.operation, null)
    })
  })
})

void describe('Workbench Git operations away from a plain branch checkout', () => {
  void test('merge and rebase need a current branch; cherry-pick works on a detached HEAD', async () => {
    await withDiverged(false, async ({ root, service, main, feature }) => {
      await git(root, ['switch', '-q', '--detach', 'main'])
      for (const action of ['merge', 'rebase'] as const)
        await assert.rejects(
          service.performOperation(root, { action, target: 'feature' }),
          isAppError('VALIDATION', /分离的 HEAD/)
        )
      assert.equal(await head(root), main)
      assert.equal((await service.getSummary(root)).operation, null)

      const picked = await service.performOperation(root, { action: 'cherry-pick', target: feature })
      assert.deepEqual(picked.operation.conflicts, [])
      assert.equal(picked.summary.status?.branch, null)
      assert.equal(await head(root, 'HEAD~1'), main)
      // main 分支自己没动。
      assert.equal(await head(root, 'main'), main)
    })
  })

  void test('a merge that conflicts outside the project is reported as stopped and can be aborted', async () => {
    await withRepository(async (root) => {
      // 项目是仓库里的子目录 app/；冲突出在项目外面的 shared.txt 上。
      const project = join(root, 'app')
      await mkdir(project)
      await writeFile(join(project, 'inside.txt'), 'inside\n')
      await commitFile(root, 'shared.txt', 'base\n', 'base')
      await git(root, ['switch', '-q', '-c', 'feature'])
      await commitFile(root, 'shared.txt', 'feature\n', 'feature edit')
      await git(root, ['switch', '-q', 'main'])
      const main = await commitFile(root, 'shared.txt', 'main\n', 'main edit')
      const service = createGitService()

      await assert.rejects(
        service.performOperation(project, { action: 'merge', target: 'feature' }),
        isAppError('VALIDATION', /合并停在了半路[\s\S]*shared\.txt/)
      )
      const summary = await service.getSummary(project)
      assert.equal(summary.operation?.kind, 'merge')
      assert.deepEqual(entryCodes(summary), [])

      const aborted = await service.performOperation(project, { action: 'abort' })
      assert.equal(aborted.summary.operation, null)
      assert.equal(await head(root), main)
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'main\n')
    })
  })
})

void describe('Workbench Git operations started elsewhere', () => {
  void test('a rebase or cherry-pick begun in the terminal shows up and can be finished here', async () => {
    await withDiverged(true, async ({ root, service, feature, main }) => {
      await assert.rejects(git(root, ['cherry-pick', feature]))
      assert.equal((await service.getSummary(root)).operation?.kind, 'cherry-pick')
      await service.performOperation(root, { action: 'abort' })

      await git(root, ['switch', '-q', 'feature'])
      // 老的 apply 后端：状态记在另一个目录里。
      await assert.rejects(git(root, ['rebase', '--apply', 'main']))
      const summary = await service.getSummary(root)
      assert.equal(summary.operation?.kind, 'rebase')
      assert.equal(summary.operation?.detail, 'feature')
      const aborted = await service.performOperation(root, { action: 'abort' })
      assert.equal(aborted.summary.operation, null)
      assert.equal(await head(root), feature)
      assert.notEqual(await head(root), main)
    })
  })
})
