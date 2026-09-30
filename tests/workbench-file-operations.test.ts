import assert from 'node:assert/strict'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { createWorkbenchAppParts, type WorkbenchAppParts } from '../src/main/workspace/Parts'

import { createFakeTrash } from './helpers/fakeTrash'

/**
 * 文件树的新建 / 改名 / 移动：看得到的都能管（点号开头的名字、dist、node_modules……），
 * 只挡越出工程与版本库内部；只改大小写的改名在大小写不敏感的文件系统上也能成。
 */

interface Workspace {
  projectRoot: string
  parts: WorkbenchAppParts
}

async function withWorkspace(run: (workspace: Workspace) => Promise<void>): Promise<void> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-file-ops-')))
  const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-file-ops-data-'))
  try {
    const trash = createFakeTrash(join(dataRoot, 'fake-trash'))
    await run({
      projectRoot,
      parts: createWorkbenchAppParts(dataRoot, { moveToTrash: trash.moveToTrash }),
    })
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
}

function isValidationError(pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof AppError && error.code === 'VALIDATION' && pattern.test(error.message)
}

void describe('Workbench file operations', () => {
  void test('dotfiles and generated-folder names can be created, renamed and moved', async () => {
    await withWorkspace(async ({ projectRoot, parts }) => {
      const files = parts.files
      const env = await files.createEntry({ projectRoot, name: '.env', type: 'file' })
      assert.equal(env.entry.path, '.env')
      assert.equal(await readFile(join(projectRoot, '.env'), 'utf8'), '')

      for (const name of ['dist', 'build', 'out', 'node_modules', '.github']) {
        const created = await files.createEntry({ projectRoot, name, type: 'directory' })
        assert.equal(created.entry.path, name)
        assert.equal(created.entry.type, 'directory')
      }

      await files.createEntry({ projectRoot, name: 'packages', type: 'directory' })
      const moved = await files.moveEntry({ projectRoot, path: 'dist', parentPath: 'packages' })
      assert.equal(moved.entry.path, 'packages/dist')
      assert.equal(moved.previousPath, 'dist')

      const renamed = await files.renameEntry({ projectRoot, path: 'build', newName: '.cache' })
      assert.equal(renamed.entry.path, '.cache')
      const envRenamed = await files.renameEntry({
        projectRoot,
        path: '.env',
        newName: '.env.local',
      })
      assert.equal(envRenamed.entry.path, '.env.local')
      assert.deepEqual(
        (await readdir(projectRoot)).sort(),
        ['.cache', '.env.local', '.github', 'node_modules', 'out', 'packages']
      )
    })
  })

  void test('version-control internals and paths outside the project stay protected', async () => {
    await withWorkspace(async ({ projectRoot, parts }) => {
      const files = parts.files
      await mkdir(join(projectRoot, '.git', 'refs'), { recursive: true })
      await writeFile(join(projectRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
      await mkdir(join(projectRoot, 'src'))
      await writeFile(join(projectRoot, 'src', 'a.ts'), 'a\n', 'utf8')

      const gitNames = ['.git', '.GIT', '.git.']
      for (const name of gitNames) {
        await assert.rejects(
          () => files.createEntry({ projectRoot, name, type: 'directory' }),
          isValidationError(/\.git/u)
        )
        await assert.rejects(
          () => files.renameEntry({ projectRoot, path: 'src', newName: name }),
          isValidationError(/\.git/u)
        )
      }
      await assert.rejects(
        () => files.createEntry({ projectRoot, parentPath: '.git', name: 'x', type: 'file' }),
        isValidationError(/版本库内部/u)
      )
      await assert.rejects(
        () => files.renameEntry({ projectRoot, path: '.git/HEAD', newName: 'HEAD2' }),
        isValidationError(/版本库内部/u)
      )
      await assert.rejects(
        () => files.moveEntry({ projectRoot, path: 'src/a.ts', parentPath: '.git/refs' }),
        isValidationError(/版本库内部/u)
      )
      await assert.rejects(
        () => files.moveEntry({ projectRoot, path: '.git', parentPath: 'src' }),
        isValidationError(/\.git|版本库内部/u)
      )
      await assert.rejects(
        () => files.deleteEntry({ projectRoot, path: '.git/HEAD' }),
        isValidationError(/版本库内部/u)
      )
      await assert.rejects(
        () => files.inspectDeleteEntry({ projectRoot, path: '.git' }),
        isValidationError(/版本库内部/u)
      )
      assert.equal(
        await readFile(join(projectRoot, '.git', 'HEAD'), 'utf8'),
        'ref: refs/heads/main\n'
      )

      for (const name of ['../escape.txt', 'nested/name', '..', '.']) {
        await assert.rejects(() => files.createEntry({ projectRoot, name, type: 'file' }))
      }
      await assert.rejects(
        () => files.moveEntry({ projectRoot, path: 'src/a.ts', parentPath: '..' }),
        (error: unknown) => error instanceof AppError && error.code === 'PERMISSION'
      )
    })
  })

  void test('a rename that only changes letter case renames the entry in place', async () => {
    await withWorkspace(async ({ projectRoot, parts }) => {
      await writeFile(join(projectRoot, 'readme.md'), '# hello\n', 'utf8')
      await mkdir(join(projectRoot, 'Components'))
      await writeFile(join(projectRoot, 'Components', 'Button.tsx'), 'export {}\n', 'utf8')

      const file = await parts.files.renameEntry({
        projectRoot,
        path: 'readme.md',
        newName: 'README.md',
      })
      assert.equal(file.entry.path, 'README.md')
      const directory = await parts.files.renameEntry({
        projectRoot,
        path: 'Components',
        newName: 'components',
      })
      assert.equal(directory.entry.path, 'components')
      assert.equal(directory.entry.type, 'directory')

      // 磁盘上的名字真的换了，内容不变，没有留下中转用的临时名。
      assert.deepEqual((await readdir(projectRoot)).sort(), ['README.md', 'components'])
      assert.equal(await readFile(join(projectRoot, 'README.md'), 'utf8'), '# hello\n')
      assert.deepEqual(await readdir(join(projectRoot, 'components')), ['Button.tsx'])
    })
  })

  void test('renaming onto a hard link of the same file is still refused', async () => {
    await withWorkspace(async ({ projectRoot, parts }) => {
      await writeFile(join(projectRoot, 'a.txt'), 'shared\n', 'utf8')
      await link(join(projectRoot, 'a.txt'), join(projectRoot, 'b.txt'))
      await writeFile(join(projectRoot, 'c.txt'), 'other\n', 'utf8')

      await assert.rejects(
        () => parts.files.renameEntry({ projectRoot, path: 'a.txt', newName: 'b.txt' }),
        isValidationError(/目标已存在/u)
      )
      await assert.rejects(
        () => parts.files.renameEntry({ projectRoot, path: 'a.txt', newName: 'c.txt' }),
        isValidationError(/目标已存在/u)
      )
      assert.deepEqual((await readdir(projectRoot)).sort(), ['a.txt', 'b.txt', 'c.txt'])
      assert.equal((await lstat(join(projectRoot, 'b.txt'))).nlink, 2)
      assert.equal(await readFile(join(projectRoot, 'c.txt'), 'utf8'), 'other\n')
    })
  })

  void test('copies files and folders, naming duplicates like Finder and keeping links as links', async () => {
    await withWorkspace(async ({ projectRoot, parts }) => {
      const files = parts.files
      await mkdir(join(projectRoot, 'src', 'util'), { recursive: true })
      await mkdir(join(projectRoot, 'lib'))
      await writeFile(join(projectRoot, 'src', 'a.ts'), 'export const a = 1\n')
      await writeFile(join(projectRoot, 'src', 'util', 'b.ts'), 'export const b = 2\n')
      await writeFile(join(projectRoot, '.env'), 'KEY=1\n')
      await symlink('../a.ts', join(projectRoot, 'src', 'util', 'a-link.ts'))

      const copied = await files.copyEntry({ projectRoot, path: 'src/a.ts', parentPath: 'lib' })
      assert.equal(copied.entry.path, 'lib/a.ts')
      assert.equal(await readFile(join(projectRoot, 'lib', 'a.ts'), 'utf8'), 'export const a = 1\n')

      // 复制到原来的目录（创建副本）：名字被占用就依次取 copy、copy 2。
      const first = await files.copyEntry({ projectRoot, path: 'src/a.ts', parentPath: 'src' })
      const second = await files.copyEntry({ projectRoot, path: 'src/a.ts', parentPath: 'src' })
      assert.deepEqual([first.entry.path, second.entry.path], ['src/a copy.ts', 'src/a copy 2.ts'])
      const env = await files.copyEntry({ projectRoot, path: '.env', parentPath: '.' })
      assert.equal(env.entry.path, '.env copy')

      // 目录连同里面的一切；链接照原样复制成链接。
      const folder = await files.copyEntry({ projectRoot, path: 'src/util', parentPath: 'lib' })
      assert.equal(folder.entry.path, 'lib/util')
      assert.equal(await readFile(join(projectRoot, 'lib', 'util', 'b.ts'), 'utf8'), 'export const b = 2\n')
      assert.ok((await lstat(join(projectRoot, 'lib', 'util', 'a-link.ts'))).isSymbolicLink())

      await assert.rejects(
        () => files.copyEntry({ projectRoot, path: 'src', parentPath: 'src/util' }),
        isValidationError(/不能把目录复制到自身或子目录内/u)
      )
      await assert.rejects(
        () => files.copyEntry({ projectRoot, path: '.', parentPath: 'lib' }),
        isValidationError(/不能复制工程根目录/u)
      )
      await assert.rejects(
        () => files.copyEntry({ projectRoot, path: 'src/a.ts', parentPath: 'src/a.ts' }),
        isValidationError(/只能复制到目录里/u)
      )
    })
  })

  void test('local history follows files and folders that are renamed or moved', async () => {
    await withWorkspace(async ({ projectRoot, parts }) => {
      const files = parts.files
      const otherRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-file-ops-other-')))
      try {
        const save = async (root: string, path: string, content: string): Promise<void> => {
          await mkdir(join(root, path, '..'), { recursive: true })
          await writeFile(join(root, path), '')
          await files.saveFile({ projectRoot: root, path, content, encoding: 'utf-8', eol: 'lf' })
        }
        const contents = (root: string, path: string): string[] =>
          files
            .listLocalHistory({ projectRoot: root, path })
            .entries.map(({ id }) => files.readLocalHistorySnapshot({ projectRoot: root, path, id }).content)

        await save(projectRoot, 'src/a.ts', 'a1\n')
        await files.saveFile({ projectRoot, path: 'src/a.ts', content: 'a2\n', encoding: 'utf-8', eol: 'lf' })
        await save(projectRoot, 'src/util/b.ts', 'b1\n')
        // 另一个项目里同样的相对路径：挪这个项目的目录时不能把它的历史也带走。
        await save(otherRoot, 'src/util/b.ts', 'other\n')

        await files.renameEntry({ projectRoot, path: 'src/a.ts', newName: 'main.ts' })
        assert.deepEqual(contents(projectRoot, 'src/main.ts'), ['a2\n', 'a1\n'])
        assert.deepEqual(contents(projectRoot, 'src/a.ts'), [])

        await files.createEntry({ projectRoot, name: 'lib', type: 'directory' })
        await files.moveEntry({ projectRoot, path: 'src/util', parentPath: 'lib' })
        assert.deepEqual(contents(projectRoot, 'lib/util/b.ts'), ['b1\n'])
        assert.deepEqual(contents(projectRoot, 'src/util/b.ts'), [])
        assert.deepEqual(contents(otherRoot, 'src/util/b.ts'), ['other\n'])

        // 改成的名字本来就有历史（那个文件删掉了）：两份历史合在一起。
        await save(projectRoot, 'src/old.ts', 'old\n')
        await rm(join(projectRoot, 'src/old.ts'))
        await files.renameEntry({ projectRoot, path: 'src/main.ts', newName: 'old.ts' })
        assert.deepEqual(contents(projectRoot, 'src/old.ts').sort(), ['a1\n', 'a2\n', 'old\n'])
      } finally {
        await rm(otherRoot, { recursive: true, force: true })
      }
    })
  })
})
