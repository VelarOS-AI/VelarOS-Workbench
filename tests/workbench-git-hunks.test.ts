import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path, { join } from 'node:path'

import { describe, test } from 'bun:test'

import {
  buildWorkbenchGitHunkPatch,
  parseWorkbenchGitFilePatches,
  type WorkbenchGitPatchHunk,
} from '../src/shared/workbenchGitPatch'

import {
  commitAll,
  createGitService,
  git,
  isAppError,
  porcelain,
  withRepository,
} from './helpers/gitRepository'

const Lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)

function text(lines: readonly string[], eol = '\n'): string {
  return `${lines.join(eol)}${eol}`
}

function edited(changes: Record<number, string>, eol = '\n'): string {
  return text(
    Lines.map((line, index) => changes[index + 1] ?? line),
    eol
  )
}

/** 这一侧的补丁里的各块（跟编辑区读到的一样：getDiff 的输出）。 */
async function readHunks(
  root: string,
  side: 'staged' | 'unstaged',
  path: string,
  originalPath?: string
): Promise<WorkbenchGitPatchHunk[]> {
  const diff = await createGitService().getDiff(root, { side, path, originalPath })
  return parseWorkbenchGitFilePatches(diff.diff)[0]?.hunks ?? []
}

void describe('Workbench Git hunks', () => {
  void test('stages one hunk, unstages it again and reverts another in the working tree', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), text(Lines))
      await commitAll(root, 'base')
      await writeFile(join(root, 'a.txt'), edited({ 2: 'LINE 2', 16: 'LINE 16' }))

      const service = createGitService()
      const [first, second] = await readHunks(root, 'unstaged', 'a.txt')
      assert.ok(first && second)
      await service.applyHunks(root, { action: 'stage', path: 'a.txt', hunks: [second] })
      assert.deepEqual(await porcelain(root), ['MM a.txt'])
      assert.equal(await git(root, ['show', ':a.txt']), edited({ 16: 'LINE 16' }))
      // 工作区不动。
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), edited({ 2: 'LINE 2', 16: 'LINE 16' }))

      const [staged] = await readHunks(root, 'staged', 'a.txt')
      assert.ok(staged)
      await service.applyHunks(root, { action: 'unstage', path: 'a.txt', hunks: [staged] })
      assert.deepEqual(await porcelain(root), [' M a.txt'])

      const [revertable] = await readHunks(root, 'unstaged', 'a.txt')
      assert.ok(revertable)
      await service.applyHunks(root, { action: 'discard', path: 'a.txt', hunks: [revertable] })
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), edited({ 16: 'LINE 16' }))
    })
  })

  void test('refuses a hunk that no longer matches the file instead of guessing', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), text(Lines))
      await commitAll(root, 'base')
      await writeFile(join(root, 'a.txt'), edited({ 2: 'LINE 2' }))
      const [shown] = await readHunks(root, 'unstaged', 'a.txt')
      assert.ok(shown)

      // 显示之后文件又改了：这一块已经不是显示的那一块。
      await writeFile(join(root, 'a.txt'), edited({ 2: 'LINE 2 again' }))
      await assert.rejects(
        createGitService().applyHunks(root, { action: 'stage', path: 'a.txt', hunks: [shown] }),
        isAppError('VALIDATION', /这段改动已经变了/)
      )
      assert.deepEqual(await porcelain(root), [' M a.txt'])
    })
  })

  void test('new files, conflicts and non-UTF-8 files only work as a whole', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), text(Lines))
      await writeFile(join(root, 'latin1.txt'), Buffer.from('caf\xe9\nline\n', 'latin1'))
      await commitAll(root, 'base')
      await writeFile(join(root, 'new.txt'), 'new\n')
      await git(root, ['add', 'new.txt'])
      await writeFile(join(root, 'latin1.txt'), Buffer.from('caf\xe9\nLINE\n', 'latin1'))

      const service = createGitService()
      const [added] = await readHunks(root, 'staged', 'new.txt')
      assert.ok(added)
      await assert.rejects(
        service.applyHunks(root, { action: 'unstage', path: 'new.txt', hunks: [added] }),
        isAppError('VALIDATION', /只能整个文件/)
      )
      const [latin] = await readHunks(root, 'unstaged', 'latin1.txt')
      assert.ok(latin)
      await assert.rejects(
        service.applyHunks(root, { action: 'stage', path: 'latin1.txt', hunks: [latin] }),
        isAppError('VALIDATION', /不是 UTF-8 编码/)
      )
      await assert.rejects(
        service.applyHunks(root, { action: 'stage', path: 'a.txt', hunks: [latin] }),
        isAppError('VALIDATION', /已经没有改动了/)
      )
    })
  })

  void test('works in a nested project, on CRLF files, on names with spaces and quotes, and keeps a staged rename', async () => {
    await withRepository(async (repository) => {
      const project = join(repository, 'my app')
      const quotedName = process.platform === 'win32' ? "a 'quoted' file.txt" : 'a "quoted" file.txt'
      await mkdir(project)
      await writeFile(join(project, quotedName), text(Lines))
      await writeFile(join(project, 'crlf.txt'), text(Lines, '\r\n'))
      await writeFile(join(project, 'old name.txt'), text(Lines))
      await commitAll(repository, 'base')

      await writeFile(join(project, quotedName), edited({ 3: 'LINE 3', 18: 'LINE 18' }))
      await writeFile(join(project, 'crlf.txt'), edited({ 5: 'LINE 5' }, '\r\n'))
      await git(repository, ['mv', 'my app/old name.txt', 'my app/new name.txt'])
      await writeFile(join(project, 'new name.txt'), edited({ 4: 'LINE 4', 17: 'LINE 17' }))
      await git(repository, ['add', 'my app/new name.txt'])

      const service = createGitService()
      const [, quoted] = await readHunks(project, 'unstaged', quotedName)
      assert.ok(quoted)
      await service.applyHunks(project, { action: 'stage', path: quotedName, hunks: [quoted] })
      assert.equal(
        await git(repository, ['show', `:my app/${quotedName}`]),
        edited({ 18: 'LINE 18' })
      )

      const [crlf] = await readHunks(project, 'unstaged', 'crlf.txt')
      assert.ok(crlf)
      await service.applyHunks(project, { action: 'stage', path: 'crlf.txt', hunks: [crlf] })
      assert.equal(await git(repository, ['show', ':my app/crlf.txt']), edited({ 5: 'LINE 5' }, '\r\n'))

      // 暂存了的改名：取消暂存其中一块，改名还在，另一块还在暂存区里。
      const [renamedFirst] = await readHunks(project, 'staged', 'new name.txt', 'old name.txt')
      assert.ok(renamedFirst)
      await service.applyHunks(project, {
        action: 'unstage',
        path: 'new name.txt',
        originalPath: 'old name.txt',
        hunks: [renamedFirst],
      })
      assert.equal(await git(repository, ['show', ':my app/new name.txt']), edited({ 17: 'LINE 17' }))
      assert.ok((await porcelain(repository)).includes('RM "my app/old name.txt" -> "my app/new name.txt"'))
    })
  })

  void test('the diff view asks before reverting a hunk and refreshes in place afterwards', () => {
    const panel = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/components/git/GitDiffEditorPanel.tsx'),
      'utf8'
    )
    assert.match(panel, /if \(actionId === 'discard'\) \{\s*setDiscardRequest\(hunkIndex\)/)
    assert.match(panel, /runHunkAction\(discardRequest, 'discard'\)/)
    assert.match(panel, /finally \{[\s\S]*reload\(\)[\s\S]*onGitStateChanged\?\.\(\)/)
  })

  void test('the patch names only the file it changes, quoted the way git reads it', () => {
    const hunk: WorkbenchGitPatchHunk = {
      header: '@@ -1 +1 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-a', '+b'],
    }
    assert.equal(
      buildWorkbenchGitHunkPatch('dir/plain name.txt', [hunk]),
      'diff --git a/dir/plain name.txt b/dir/plain name.txt\n--- a/dir/plain name.txt\n+++ b/dir/plain name.txt\n@@ -1 +1 @@\n-a\n+b\n'
    )
    assert.match(
      buildWorkbenchGitHunkPatch('q"u\\o\tte.txt', [hunk]),
      /^diff --git "a\/q\\"u\\\\o\\tte\.txt" "b\/q\\"u\\\\o\\tte\.txt"$/m
    )
  })
})
