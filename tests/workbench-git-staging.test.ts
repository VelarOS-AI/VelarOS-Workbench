import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import {
  buildCommitPanelGroups,
  resolveCommitPanelCommitMode,
  summarizeCommitPanelCommitAll,
} from '../src/renderer/src/models/git/commitPanel.model'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitDecorationMap,
} from '../src/renderer/src/models/git/workbenchGitModel'

import {
  commitAll,
  createGitService,
  entryCodes,
  filesInCommit,
  git,
  isAppError,
  porcelain,
  withRepository,
} from './helpers/gitRepository'

void describe('Workbench Git staging area', () => {
  void test('stages and unstages several files at once', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), 'a\n')
      await writeFile(join(root, 'b.txt'), 'b\n')
      await commitAll(root, 'base')
      await writeFile(join(root, 'a.txt'), 'a changed\n')
      await writeFile(join(root, 'b.txt'), 'b changed\n')
      await writeFile(join(root, 'new.txt'), 'new\n')

      const service = createGitService()
      const staged = await service.performFileAction(root, ['a.txt', 'new.txt', 'b.txt'], 'stage')
      assert.deepEqual(staged.fileAction.paths, ['a.txt', 'new.txt', 'b.txt'])
      assert.deepEqual(await porcelain(root), ['M  a.txt', 'M  b.txt', 'A  new.txt'])

      const unstaged = await service.performFileAction(root, ['a.txt', 'new.txt'], 'unstage')
      assert.equal(unstaged.fileAction.status.stagedFiles, 1)
      assert.deepEqual(await porcelain(root), [' M a.txt', 'M  b.txt', '?? new.txt'])
      // 取消暂存不碰工作区里的文件；本来就没暂存的跳过。
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a changed\n')
      await service.performFileAction(root, ['a.txt'], 'unstage')
      assert.deepEqual(await porcelain(root), [' M a.txt', 'M  b.txt', '?? new.txt'])

      await assert.rejects(
        service.performFileAction(root, ['../outside.txt'], 'stage'),
        isAppError('PERMISSION', /超出项目根目录/)
      )
    })
  })

  void test('rolling back a partly staged file drops only the unstaged part; a fully staged one goes back to HEAD', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'partly.txt'), 'head\n')
      await writeFile(join(root, 'staged.txt'), 'head\n')
      await commitAll(root, 'base')
      await writeFile(join(root, 'partly.txt'), 'staged\n')
      await writeFile(join(root, 'staged.txt'), 'staged\n')
      await writeFile(join(root, 'added.txt'), 'added\n')
      await git(root, ['add', 'partly.txt', 'staged.txt', 'added.txt'])
      await writeFile(join(root, 'partly.txt'), 'staged\nand more\n')

      const service = createGitService()
      await service.performFileAction(root, ['partly.txt'], 'discard')
      assert.equal(await readFile(join(root, 'partly.txt'), 'utf8'), 'staged\n')
      assert.deepEqual(await porcelain(root), ['A  added.txt', 'M  partly.txt', 'M  staged.txt'])

      await service.performFileAction(root, ['staged.txt', 'added.txt'], 'discard')
      assert.equal(await readFile(join(root, 'staged.txt'), 'utf8'), 'head\n')
      assert.equal(existsSync(join(root, 'added.txt')), false)
      assert.deepEqual(await porcelain(root), ['M  partly.txt'])
    })
  })

  void test('committing the index takes what is staged and leaves unstaged changes in the working tree', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'partly.txt'), 'head\n')
      await writeFile(join(root, 'other.txt'), 'head\n')
      await writeFile(join(root, 'gone.txt'), 'gone\n')
      await commitAll(root, 'base')
      await writeFile(join(root, 'partly.txt'), 'staged\n')
      await git(root, ['add', 'partly.txt'])
      await writeFile(join(root, 'partly.txt'), 'staged\nworking\n')
      await writeFile(join(root, 'other.txt'), 'not staged\n')
      await git(root, ['rm', '-q', 'gone.txt'])
      await writeFile(join(root, 'untracked.txt'), 'new\n')

      const service = createGitService()
      const committed = await service.commitStaged(root, 'en-US', 'staged only')
      assert.equal(committed.commit.message, 'staged only')
      assert.deepEqual(await filesInCommit(root, 'HEAD'), ['gone.txt', 'partly.txt'])
      assert.equal(await git(root, ['show', 'HEAD:partly.txt']), 'staged\n')
      assert.deepEqual(entryCodes(committed.summary), [' M other.txt', ' M partly.txt', '?? untracked.txt'])

      await assert.rejects(
        service.commitStaged(root, 'en-US'),
        isAppError('VALIDATION', /暂存区里没有可提交的改动/)
      )
    })
  })

  void test('a nested project commits only its own staged changes', async () => {
    await withRepository(async (repository) => {
      const project = join(repository, 'packages', 'app')
      await mkdir(project, { recursive: true })
      await writeFile(join(project, 'a.txt'), 'a\n')
      await writeFile(join(project, 'gone.txt'), 'gone\n')
      await writeFile(join(repository, 'outside.txt'), 'outside\n')
      await commitAll(repository, 'base')

      await writeFile(join(project, 'a.txt'), 'a staged\n')
      await writeFile(join(project, 'new.txt'), 'new\n')
      await writeFile(join(repository, 'outside.txt'), 'outside staged\n')
      await git(repository, ['add', '-A'])
      await git(repository, ['rm', '-q', 'packages/app/gone.txt'])
      await writeFile(join(project, 'a.txt'), 'a staged\nnot staged\n')
      // `git add -N` 记下的空条目不算暂存，不能被提交。
      await writeFile(join(project, 'intent.txt'), 'intent\n')
      await git(repository, ['add', '-N', 'packages/app/intent.txt'])

      const service = createGitService()
      const committed = await service.commitStaged(project, 'en-US', 'project only')
      assert.deepEqual(await filesInCommit(repository, 'HEAD'), [
        'packages/app/a.txt',
        'packages/app/gone.txt',
        'packages/app/new.txt',
      ])
      assert.equal(await git(repository, ['show', 'HEAD:packages/app/a.txt']), 'a staged\n')
      assert.equal(committed.commit.changedFiles, 3)
      // 项目外面暂存的改动留在暂存区，项目里没暂存的留在工作区。
      assert.deepEqual(await porcelain(repository), [
        'M  outside.txt',
        ' M packages/app/a.txt',
        ' A packages/app/intent.txt',
      ])
      // 用的是一份临时索引，用完就删。
      assert.equal(
        (await readdir(join(repository, '.git'))).some((name) => name.startsWith('velaros-commit-')),
        false
      )
    })
  })

  void test('committing the index during a merge completes the merge', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'both.txt'), 'base\n')
      await commitAll(root, 'base')
      await git(root, ['switch', '-q', '-c', 'feature'])
      await writeFile(join(root, 'both.txt'), 'feature\n')
      await commitAll(root, 'feature')
      await git(root, ['switch', '-q', 'main'])
      await writeFile(join(root, 'both.txt'), 'main\n')
      await commitAll(root, 'main')
      await assert.rejects(git(root, ['merge', 'feature']))

      const service = createGitService()
      await assert.rejects(
        service.commitStaged(root, 'en-US'),
        isAppError('VALIDATION', /还有未解决的合并冲突/)
      )
      // 暂存冲突文件就是标记为已解决：还有冲突标记时拒绝。
      await assert.rejects(
        service.performFileAction(root, ['both.txt'], 'stage'),
        isAppError('VALIDATION', /还有冲突标记/)
      )
      await writeFile(join(root, 'both.txt'), 'resolved\n')
      await service.performFileAction(root, ['both.txt'], 'stage')
      const merged = await service.commitStaged(root, 'en-US')
      assert.equal(merged.commit.message, "Merge branch 'feature'")
      assert.equal(
        (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length,
        3
      )
    })
  })

})

void describe('Workbench commit panel staging groups', () => {
  const items = buildWorkbenchGitChangeItems([
    { path: 'src/partly.ts', indexStatus: 'M', workTreeStatus: 'M' },
    { path: 'src/staged.ts', indexStatus: 'M', workTreeStatus: ' ' },
    { path: 'src/edited.ts', indexStatus: ' ', workTreeStatus: 'M' },
    { path: 'src/moved.ts', originalPath: 'src/old.ts', indexStatus: 'R', workTreeStatus: 'M' },
    { path: 'notes.md', indexStatus: '?', workTreeStatus: '?' },
    { path: 'src/both.ts', indexStatus: 'U', workTreeStatus: 'U' },
  ])

  void test('a partly staged file is listed under both Staged and Changes', () => {
    assert.deepEqual(
      buildCommitPanelGroups(items).map((group) => [
        group.id,
        group.items.map((item) => `${item.statusCode} ${item.path}`),
      ]),
      [
        ['conflicted', ['UU src/both.ts']],
        ['staged', ['R src/moved.ts', 'M src/partly.ts', 'M src/staged.ts']],
        ['changed', ['M src/edited.ts', 'M src/moved.ts', 'M src/partly.ts']],
        ['untracked', ['?? notes.md']],
      ]
    )
    // 文件树里一个文件只标一次。
    assert.equal(buildWorkbenchGitDecorationMap(items).get('src/partly.ts')?.statusCode, 'MM')
  })

  void test('commits the index when something is staged, otherwise the checked files', () => {
    assert.equal(resolveCommitPanelCommitMode(items), 'staged')
    assert.equal(
      resolveCommitPanelCommitMode(items.filter((item) => item.group !== 'staged')),
      'selection'
    )
    assert.deepEqual(summarizeCommitPanelCommitAll(items.filter((item) => item.group !== 'conflicted')), {
      count: 5,
      untracked: 1,
    })
  })
})
