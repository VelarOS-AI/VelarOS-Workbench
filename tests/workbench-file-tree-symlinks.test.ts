import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'

import { createWorkbenchAppParts, type WorkbenchAppParts } from '../src/main/workspace/Parts'
import { WorkbenchProjectFileSystem } from '../src/main/workspace/WorkbenchProjectFileSystem'
import { isUnresolvedTreeSymlink } from '../src/renderer/src/models/files/fileTree.model'

import { createFakeTrash, type FakeTrash } from './helpers/fakeTrash'

/**
 * 符号链接：树里总能看到链接本身；目标在工程外或已不存在的只显示、不跟进去；改名、移动、删除动的
 * 永远是链接本身，不是它指向的东西。
 */

interface LinkedProject {
  projectRoot: string
  outsideRoot: string
  parts: WorkbenchAppParts
  trash: FakeTrash
}

async function withLinkedProject(run: (project: LinkedProject) => Promise<void>): Promise<void> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-links-project-')))
  const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-links-outside-')))
  const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-links-data-'))
  try {
    await mkdir(join(projectRoot, 'src'))
    await writeFile(join(projectRoot, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    await mkdir(join(projectRoot, 'sub'))
    await mkdir(join(outsideRoot, 'shared'))
    await writeFile(join(outsideRoot, 'shared', 'secret.txt'), 'outside\n', 'utf8')
    await writeFile(join(outsideRoot, 'notes.md'), '# outside\n', 'utf8')

    await symlink('src', join(projectRoot, 'src-link'))
    await symlink(join('src', 'a.ts'), join(projectRoot, 'a-link.ts'))
    await symlink(join(outsideRoot, 'shared'), join(projectRoot, 'shared'))
    await symlink(join(outsideRoot, 'notes.md'), join(projectRoot, 'notes.md'))
    await symlink('does-not-exist', join(projectRoot, 'broken'))

    const trash = createFakeTrash(join(dataRoot, 'fake-trash'))
    const parts = createWorkbenchAppParts(dataRoot, { moveToTrash: trash.moveToTrash })
    await run({ projectRoot, outsideRoot, parts, trash })
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
}

function isOutsideProjectError(error: unknown): boolean {
  return error instanceof Error && /路径超出工程范围/u.test(error.message)
}

void describe('Workbench file tree symlinks', () => {
  void test('the tree lists every link and never follows targets outside the project', async () => {
    await withLinkedProject(async ({ projectRoot }) => {
      const service = new WorkbenchProjectFileSystem()
      const root = await service.listDirectory({ projectRoot, includeHidden: true })
      const byName = new Map(root.entries.map((entry) => [entry.name, entry]))

      assert.deepEqual([...byName.keys()].sort(), [
        'a-link.ts',
        'broken',
        'notes.md',
        'shared',
        'src',
        'src-link',
        'sub',
      ])
      assert.equal(byName.get('src')?.symlink, undefined)
      assert.deepEqual(byName.get('src-link')?.symlink, { target: 'src', targetState: 'inside' })
      assert.equal(byName.get('src-link')?.type, 'directory')
      assert.equal(byName.get('src-link')?.hasChildren, true)
      assert.equal(byName.get('a-link.ts')?.type, 'file')
      assert.equal(byName.get('a-link.ts')?.symlink?.targetState, 'inside')

      for (const name of ['shared', 'notes.md', 'broken']) {
        const entry = byName.get(name)!
        // 在工程外或已不存在：一项不能展开的叶子，不带目标的任何信息。
        assert.equal(entry.type, 'file', name)
        assert.equal(entry.hasChildren, false, name)
        assert.equal(entry.size, null, name)
        assert.equal(isUnresolvedTreeSymlink(entry), true, name)
      }
      assert.equal(byName.get('shared')?.symlink?.targetState, 'outside')
      assert.equal(byName.get('notes.md')?.symlink?.targetState, 'outside')
      assert.deepEqual(byName.get('broken')?.symlink, {
        target: 'does-not-exist',
        targetState: 'missing',
      })
      assert.equal(isUnresolvedTreeSymlink(byName.get('src-link')!), false)
      assert.equal(isUnresolvedTreeSymlink(byName.get('src')!), false)
      // 树里点开这样的链接只选中它，不去打开；也不挂到聊天里。
      const actions = readFileSync('src/renderer/src/hooks/useFileTreeActions.ts', 'utf8')
      assert.match(actions, /if \(isUnresolvedTreeSymlink\(node\.data\.entry\)\) \{/u)
      const tree = readFileSync('src/renderer/src/components/files/FileTree.tsx', 'utf8')
      assert.match(tree, /candidate\.type === 'file' && !isUnresolvedTreeSymlink\(candidate\)/u)

      await assert.rejects(
        () => service.listDirectory({ projectRoot, path: 'shared' }),
        isOutsideProjectError
      )
      await assert.rejects(
        () => service.readTextFile({ projectRoot, path: 'notes.md' }),
        isOutsideProjectError
      )
    })
  })

  void test('a directory link expands under its own path, not the target path', async () => {
    await withLinkedProject(async ({ projectRoot }) => {
      const service = new WorkbenchProjectFileSystem()
      const linked = await service.listDirectory({ projectRoot, path: 'src-link' })
      assert.equal(linked.path, 'src-link')
      assert.deepEqual(
        linked.entries.map((entry) => entry.path),
        ['src-link/a.ts']
      )
      const file = await service.readTextFile({ projectRoot, path: 'src-link/a.ts' })
      assert.equal(file.content, 'export const a = 1\n')
    })
  })

  void test('links are renamed and moved themselves, whatever they point to', async () => {
    await withLinkedProject(async ({ projectRoot, outsideRoot, parts }) => {
      const renamed = await parts.files.renameEntry({
        projectRoot,
        path: 'shared',
        newName: 'shared-docs',
      })
      assert.equal(renamed.entry.path, 'shared-docs')
      assert.deepEqual(renamed.entry.symlink, {
        target: join(outsideRoot, 'shared'),
        targetState: 'outside',
      })
      assert.equal((await lstat(join(projectRoot, 'shared-docs'))).isSymbolicLink(), true)
      assert.deepEqual(await readdir(join(outsideRoot, 'shared')), ['secret.txt'])

      const movedOutside = await parts.files.moveEntry({
        projectRoot,
        path: 'notes.md',
        parentPath: 'sub',
      })
      assert.equal(movedOutside.entry.path, 'sub/notes.md')
      assert.equal(movedOutside.entry.symlink?.targetState, 'outside')
      assert.equal(await readFile(join(outsideRoot, 'notes.md'), 'utf8'), '# outside\n')

      const movedBroken = await parts.files.moveEntry({
        projectRoot,
        path: 'broken',
        parentPath: 'sub',
      })
      assert.equal(movedBroken.entry.symlink?.targetState, 'missing')
      assert.equal(await readlink(join(projectRoot, 'sub', 'broken')), 'does-not-exist')

      // 目录链接挪进它指向的目录里也行：挪的只是链接。
      const movedDirectoryLink = await parts.files.moveEntry({
        projectRoot,
        path: 'src-link',
        parentPath: 'src',
      })
      assert.equal(movedDirectoryLink.entry.path, 'src/src-link')
      assert.deepEqual((await readdir(join(projectRoot, 'src'))).sort(), ['a.ts', 'src-link'])
    })
  })

  void test('a directory cannot be moved into itself through a link alias', async () => {
    await withLinkedProject(async ({ projectRoot, parts }) => {
      await mkdir(join(projectRoot, 'src', 'nested'))
      await assert.rejects(
        () => parts.files.moveEntry({ projectRoot, path: 'src', parentPath: 'src-link/nested' }),
        (error: unknown) => error instanceof AppError && /自身或子目录/u.test(error.message)
      )
    })
  })

  void test('deleting a link trashes the link and undo puts the same link back', async () => {
    await withLinkedProject(async ({ projectRoot, outsideRoot, parts, trash }) => {
      const preview = await parts.files.inspectDeleteEntry({ projectRoot, path: 'src-link' })
      // 指向目录的链接也按一项叶子删，不问目录里有什么。
      assert.equal(preview.type, 'file')

      const directoryLink = await parts.files.deleteEntry({ projectRoot, path: 'src-link' })
      const outsideLink = await parts.files.deleteEntry({ projectRoot, path: 'shared' })
      const brokenLink = await parts.files.deleteEntry({ projectRoot, path: 'broken' })
      assert.deepEqual(trash.trashed, [
        join(projectRoot, 'src-link'),
        join(projectRoot, 'shared'),
        join(projectRoot, 'broken'),
      ])
      // 目标一个没动。
      assert.deepEqual(await readdir(join(projectRoot, 'src')), ['a.ts'])
      assert.deepEqual(await readdir(join(outsideRoot, 'shared')), ['secret.txt'])

      for (const result of [directoryLink, outsideLink, brokenLink]) {
        assert.ok(result.restoreId)
        await parts.files.restoreDeletedEntry({ projectRoot, restoreId: result.restoreId })
      }
      assert.equal(await readlink(join(projectRoot, 'src-link')), 'src')
      assert.equal(await readlink(join(projectRoot, 'shared')), join(outsideRoot, 'shared'))
      assert.equal(await readlink(join(projectRoot, 'broken')), 'does-not-exist')
    })
  })
})
