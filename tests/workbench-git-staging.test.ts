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
import { buildWorkbenchGitPatchRows } from '../src/renderer/src/models/git/workbenchGitDiffModel'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitDecorationMap,
} from '../src/renderer/src/models/git/workbenchGitModel'
import {
  isWorkbenchGitWholeFilePatch,
  parseWorkbenchGitFilePatches,
} from '../src/shared/workbenchGitPatch'

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
  void test('unstages a batch longer than the Windows command line without changing files', async () => {
    await withRepository(async (root) => {
      const paths = Array.from(
        { length: 256 },
        (_, index) => `${String(index).padStart(3, '0')}-${'x'.repeat(120)}[entry].txt`
      )
      assert.ok(paths.join(' ').length > 32_767)
      await Promise.all(paths.map((path) => writeFile(join(root, path), 'base\n')))
      const service = createGitService()
      await service.performFileAction(root, paths, 'stage')
      const unborn = await service.performFileAction(root, paths, 'unstage')
      assert.equal(unborn.fileAction.status.stagedFiles, 0)
      assert.equal(unborn.fileAction.status.untrackedFiles, paths.length)

      await commitAll(root, 'base')
      await Promise.all(paths.map((path) => writeFile(join(root, path), 'changed\n')))
      await service.performFileAction(root, paths, 'stage')
      const unstaged = await service.performFileAction(root, paths, 'unstage')
      assert.equal(unstaged.fileAction.status.stagedFiles, 0)
      assert.equal(unstaged.fileAction.status.unstagedFiles, paths.length)
      assert.equal(await readFile(join(root, paths[0]!), 'utf8'), 'changed\n')
      assert.equal(await readFile(join(root, paths.at(-1)!), 'utf8'), 'changed\n')
    })
  })

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

  void test('the diff of each side: staged is HEAD to index, unstaged is index to working tree', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), 'head\n')
      await commitAll(root, 'base')
      await writeFile(join(root, 'a.txt'), 'staged\n')
      await git(root, ['add', 'a.txt'])
      await writeFile(join(root, 'a.txt'), 'working\n')

      const service = createGitService()
      const staged = await service.getDiff(root, { side: 'staged', path: 'a.txt' })
      assert.equal(staged.scope, 'staged')
      assert.match(staged.diff, /^-head$/m)
      assert.match(staged.diff, /^\+staged$/m)
      const unstaged = await service.getDiff(root, { side: 'unstaged', path: 'a.txt' })
      assert.equal(unstaged.scope, 'unstaged')
      assert.match(unstaged.diff, /^-staged$/m)
      assert.match(unstaged.diff, /^\+working$/m)

      // 改名暂存了、改名后又改了内容：暂存那一侧是改名，工作区那一侧只看新路径。
      await writeFile(join(root, 'old.txt'), 'one\ntwo\nthree\n')
      await commitAll(root, 'old')
      await git(root, ['mv', 'old.txt', 'new.txt'])
      await writeFile(join(root, 'new.txt'), 'one\ntwo\nthree\nfour\n')
      const renamed = await service.getDiff(root, {
        side: 'staged',
        path: 'new.txt',
        originalPath: 'old.txt',
      })
      assert.match(renamed.diff, /^rename from old\.txt$/m)
      const edited = await service.getDiff(root, { side: 'unstaged', path: 'new.txt' })
      assert.match(edited.diff, /^\+four$/m)
      assert.doesNotMatch(edited.diff, /rename/)
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
    // 改名暂存了：暂存那一侧带着改名前的路径，工作区那一侧只对照暂存区里的新路径。
    const moved = items.filter((item) => item.path === 'src/moved.ts')
    assert.deepEqual(
      moved.map((item) => [item.group, item.originalPath]),
      [
        ['staged', 'src/old.ts'],
        ['unstaged', undefined],
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

void describe('Workbench Git patch rows', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '@@ -8,3 +8,4 @@',
    ' eight',
    ' nine',
    ' ten',
    '+eleven',
    '',
  ].join('\n')
  const current = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n'

  void test('parses the hunks git wrote', () => {
    const [patch] = parseWorkbenchGitFilePatches(diff)
    assert.ok(patch)
    assert.equal(patch.hunks.length, 2)
    assert.deepEqual(
      patch.hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
      [
        [1, 3, 1, 3],
        [8, 3, 8, 4],
      ]
    )
    assert.equal(isWorkbenchGitWholeFilePatch(patch), false)
    assert.equal(
      isWorkbenchGitWholeFilePatch(
        parseWorkbenchGitFilePatches(
          'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n'
        )[0]
      ),
      true
    )
    // 被截断的补丁：最后一块读不满。
    const [cut] = parseWorkbenchGitFilePatches(diff.slice(0, diff.indexOf(' nine')))
    assert.equal(cut?.incomplete, true)
  })

  void test('lays the hunks over the whole file, each row knowing its hunk', () => {
    const [patch] = parseWorkbenchGitFilePatches(diff)
    const { rows, fullFile } = buildWorkbenchGitPatchRows(patch, { side: 'new', text: current })
    assert.equal(fullFile, true)
    assert.deepEqual(
      rows.map((row) => `${row.kind[0]}${row.hunk ?? '.'} ${row.oldLine ?? '-'}/${row.newLine ?? '-'} ${row.text}`),
      [
        'c0 1/1 one',
        'd0 2/- two',
        'a0 -/2 TWO',
        'c0 3/3 three',
        'c. 4/4 four',
        'c. 5/5 five',
        'c. 6/6 six',
        'c. 7/7 seven',
        'c1 8/8 eight',
        'c1 9/9 nine',
        'c1 10/10 ten',
        'a1 -/11 eleven',
      ]
    )

    // 全文对不上补丁（读完之后又改过）：只铺各块改动，块与块之间放一行块头。
    const stale = buildWorkbenchGitPatchRows(patch, { side: 'new', text: 'something else\n' })
    assert.equal(stale.fullFile, false)
    assert.deepEqual(
      stale.rows.map((row) => row.kind),
      ['context', 'deletion', 'addition', 'context', 'hunk', 'context', 'context', 'context', 'addition']
    )
  })

  void test('the old side works too, and CRLF line ends are not content', () => {
    const [patch] = parseWorkbenchGitFilePatches(
      'diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -2 +2 @@\n-b\r\n+B\r\n'
    )
    const { rows, fullFile } = buildWorkbenchGitPatchRows(patch, { side: 'old', text: 'a\nb\nc\n' })
    assert.equal(fullFile, true)
    assert.deepEqual(
      rows.map((row) => `${row.kind[0]} ${row.text}`),
      ['c a', 'd b', 'a B', 'c c']
    )
  })
})
