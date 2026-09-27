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
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { createWorkbenchAppParts, type WorkbenchAppParts } from '../src/main/workspace/Parts'

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
    await run({ projectRoot, parts: createWorkbenchAppParts(dataRoot) })
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
})
