import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import { WorkbenchProjectFileSystem } from '../src/main/workspace/WorkbenchProjectFileSystem'
import { resolveExternalFileUnavailableStatus } from '../src/renderer/src/models/editor/workbenchEditorTabs'
import { getWorkbenchFileTreeShortcutAction } from '../src/renderer/src/models/files/workbenchTreeMutation'

import { createFakeTrash, refuseTrash } from './helpers/fakeTrash'

const execFileAsync = promisify(execFile)

void describe('Workbench project file tree', () => {
  void test('reads PNG, SVG, and WebP files through the read-only image channel', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-image-files-'))
    const service = new WorkbenchProjectFileSystem()
    const png = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    )
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
      0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
    ])
    const images = [
      {
        path: 'assets/pixel.png',
        mediaType: 'image/png',
        data: png,
      },
      {
        path: 'assets/mark.svg',
        mediaType: 'image/svg+xml',
        data: new TextEncoder().encode(
          '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
        ),
      },
      {
        path: 'assets/photo.webp',
        mediaType: 'image/webp',
        data: webp,
      },
    ] as const

    try {
      await mkdir(join(projectRoot, 'assets'))
      for (const image of images) await writeFile(join(projectRoot, image.path), image.data)

      for (const image of images) {
        const result = await service.readImageFile({ projectRoot, path: image.path })
        assert.equal(result.path, image.path)
        assert.equal(result.content, '')
        assert.equal(result.totalLines, 1)
        assert.equal(result.truncated, false)
        assert.equal(result.size, image.data.byteLength)
        assert.equal(result.imagePreview.mediaType, image.mediaType)
        assert.deepEqual(result.imagePreview.data, image.data)
      }

      await assert.rejects(
        () => service.readTextFile({ projectRoot, path: images[0].path }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'VALIDATION' &&
          /不是可预览的文本文件/u.test(error.message)
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('rejects mismatched image contents and files above the requested preview limit', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-invalid-images-'))
    const service = new WorkbenchProjectFileSystem()

    try {
      await writeFile(join(projectRoot, 'mismatch.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      await writeFile(
        join(projectRoot, 'nested.svg'),
        '<html><body><svg xmlns="http://www.w3.org/2000/svg"/></body></html>'
      )
      await writeFile(
        join(projectRoot, 'invalid-utf8.svg'),
        Uint8Array.from([0xff, 0xfe, 0x3c, 0x73, 0x76, 0x67, 0x2f, 0x3e])
      )
      await writeFile(
        join(projectRoot, 'oversized.png'),
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )

      await assert.rejects(
        () => service.readImageFile({ projectRoot, path: 'mismatch.png' }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'VALIDATION' &&
          /内容与文件格式不匹配/u.test(error.message)
      )
      for (const path of ['nested.svg', 'invalid-utf8.svg']) {
        await assert.rejects(
          () => service.readImageFile({ projectRoot, path }),
          (error: unknown) =>
            error instanceof AppError &&
            error.code === 'VALIDATION' &&
            /内容与文件格式不匹配/u.test(error.message)
        )
      }
      await assert.rejects(
        () =>
          service.readImageFile({
            projectRoot,
            path: 'oversized.png',
            maxBytes: 7,
          }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'VALIDATION' &&
          /预览上限/u.test(error.message)
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('restores Git-ignored decoration for generated directories and their descendants', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-file-tree-'))
    const service = new WorkbenchProjectFileSystem()

    try {
      await execFileAsync('git', ['init', projectRoot])
      await writeFile(join(projectRoot, '.gitignore'), 'dist/\nnode_modules/\n', 'utf8')
      await mkdir(join(projectRoot, 'dist', 'nested'), { recursive: true })
      await mkdir(join(projectRoot, 'node_modules', 'package'), { recursive: true })
      await mkdir(join(projectRoot, 'src'), { recursive: true })
      await writeFile(join(projectRoot, 'dist', 'nested', 'bundle.js'), '', 'utf8')
      await writeFile(join(projectRoot, 'node_modules', 'package', 'index.js'), '', 'utf8')
      await writeFile(join(projectRoot, 'src', 'main.ts'), '', 'utf8')

      const root = await service.listDirectory({ projectRoot })
      assert.equal(root.entries.find((entry) => entry.name === 'dist')?.gitIgnored, true)
      assert.equal(root.entries.find((entry) => entry.name === 'node_modules')?.gitIgnored, true)
      assert.equal(root.entries.find((entry) => entry.name === 'src')?.gitIgnored, false)

      const ignoredChild = await service.listDirectory({ projectRoot, path: 'dist' })
      assert.equal(ignoredChild.entries.find((entry) => entry.name === 'nested')?.gitIgnored, true)

      const ignoredFile = await service.readTextFile({
        projectRoot,
        path: 'dist/nested/bundle.js',
      })
      const editableFile = await service.readTextFile({ projectRoot, path: 'src/main.ts' })
      assert.equal(ignoredFile.gitIgnored, true)
      assert.equal(editableFile.gitIgnored, false)
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('lists and reads entries whose names start with two dots', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-dot-dot-names-'))
    const service = new WorkbenchProjectFileSystem()

    try {
      await writeFile(join(projectRoot, '..notes.md'), '# kept\n', 'utf8')
      await mkdir(join(projectRoot, '..cache'))
      await writeFile(join(projectRoot, '..cache', 'entry.txt'), 'inside\n', 'utf8')

      const root = await service.listDirectory({ projectRoot, includeHidden: true })
      assert.deepEqual(
        root.entries.map((entry) => [entry.path, entry.type]),
        [
          ['..cache', 'directory'],
          ['..notes.md', 'file'],
        ]
      )
      const nested = await service.listDirectory({ projectRoot, path: '..cache' })
      assert.deepEqual(nested.entries.map((entry) => entry.path), ['..cache/entry.txt'])
      const notes = await service.readTextFile({ projectRoot, path: '..notes.md' })
      assert.equal(notes.content, '# kept\n')

      // 真正往上走的 `..` 仍然越界。
      await assert.rejects(
        () => service.listDirectory({ projectRoot, path: '..' }),
        /路径超出工程范围/u
      )
      await assert.rejects(
        () => service.readTextFile({ projectRoot, path: '../outside.txt' }),
        /路径超出工程范围/u
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('reports a deleted file as NOT_FOUND without leaking the realpath ENOENT', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-deleted-file-'))
    const service = new WorkbenchProjectFileSystem()

    try {
      await assert.rejects(
        () => service.readTextFile({ projectRoot, path: 'removed.yml' }),
        (error: unknown) => {
          assert.ok(error instanceof AppError)
          assert.equal(error.code, 'NOT_FOUND')
          assert.match(error.message, /已被删除或移动/u)
          assert.doesNotMatch(error.message, /ENOENT|realpath/u)
          return true
        }
      )
      assert.equal(resolveExternalFileUnavailableStatus('NOT_FOUND'), 'deleted')
      assert.equal(resolveExternalFileUnavailableStatus('PERMISSION'), 'unavailable')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('reports a deleted directory as NOT_FOUND without leaking the realpath ENOENT', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-deleted-directory-'))
    const service = new WorkbenchProjectFileSystem()

    try {
      await assert.rejects(
        () => service.listDirectory({ projectRoot, path: 'packages/hash/src' }),
        (error: unknown) => {
          assert.ok(error instanceof AppError)
          assert.equal(error.code, 'NOT_FOUND')
          assert.match(error.message, /目录已被删除或移动/u)
          assert.doesNotMatch(error.message, /ENOENT|realpath/u)
          return true
        }
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('restores a missing file from the preserved editor buffer, including dotfiles', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-restore-file-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-restore-data-'))
    const parts = createWorkbenchAppParts(dataRoot, { moveToTrash: refuseTrash })

    try {
      const restored = await parts.files.restoreMissingFile({
        projectRoot,
        path: '.env.local',
        content: 'WORKBENCH_PORT=3000\n',
      })
      assert.equal(restored.path, '.env.local')
      assert.equal(restored.content, 'WORKBENCH_PORT=3000\n')
      assert.equal(await readFile(join(projectRoot, '.env.local'), 'utf8'), restored.content)

      await assert.rejects(
        () =>
          parts.files.restoreMissingFile({
            projectRoot,
            path: '.env.local',
            content: 'WORKBENCH_PORT=4000\n',
          }),
        (error: unknown) => error instanceof AppError && error.code === 'CONFLICT'
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('deletes empty directories immediately and confirms content before recursive deletion', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-delete-project-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-delete-data-'))
    const trash = createFakeTrash(join(dataRoot, 'fake-trash'))
    const parts = createWorkbenchAppParts(dataRoot, { moveToTrash: trash.moveToTrash })

    try {
      await mkdir(join(projectRoot, 'empty'))
      const emptyPreview = await parts.files.inspectDeleteEntry({
        projectRoot,
        path: 'empty',
      })
      assert.equal(emptyPreview.type, 'directory')
      assert.equal(emptyPreview.requiresConfirmation, false)

      const emptyDelete = await parts.files.deleteEntry({ projectRoot, path: 'empty' })
      await assert.rejects(() => readFile(join(projectRoot, 'empty')), /ENOENT/u)
      assert.ok(emptyDelete.restoreId)
      await parts.files.restoreDeletedEntry({
        projectRoot,
        restoreId: emptyDelete.restoreId,
      })

      await mkdir(join(projectRoot, 'filled', 'nested'), { recursive: true })
      await writeFile(join(projectRoot, 'filled', 'nested', '.hidden'), 'preserved', 'utf8')
      const filledPreview = await parts.files.inspectDeleteEntry({
        projectRoot,
        path: 'filled',
      })
      assert.equal(filledPreview.type, 'directory')
      assert.equal(filledPreview.requiresConfirmation, true)

      await assert.rejects(
        () => parts.files.deleteEntry({ projectRoot, path: 'filled' }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'VALIDATION' &&
          /需要确认/u.test(error.message)
      )
      assert.equal(await readFile(join(projectRoot, 'filled', 'nested', '.hidden'), 'utf8'), 'preserved')

      const filledDelete = await parts.files.deleteEntry({
        projectRoot,
        path: 'filled',
        recursive: true,
      })
      await assert.rejects(
        () => readFile(join(projectRoot, 'filled', 'nested', '.hidden')),
        /ENOENT/u
      )
      assert.ok(filledDelete.restoreId)
      await parts.files.restoreDeletedEntry({
        projectRoot,
        restoreId: filledDelete.restoreId,
      })
      assert.equal(trash.trashed.length, 2)
      assert.equal(await readFile(join(projectRoot, 'filled', 'nested', '.hidden'), 'utf8'), 'preserved')

      const filePreview = await parts.files.inspectDeleteEntry({
        projectRoot,
        path: 'filled/nested/.hidden',
      })
      assert.equal(filePreview.type, 'file')
      assert.equal(filePreview.requiresConfirmation, true)
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('tells which terminal paths are files inside the project, without reading them', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-existing-files-'))
    const outside = await mkdtemp(join(tmpdir(), 'workbench-existing-outside-'))
    const service = new WorkbenchProjectFileSystem()
    try {
      await mkdir(join(projectRoot, 'src'))
      await writeFile(join(projectRoot, 'src', 'a.ts'), 'export {}\n')
      await writeFile(join(projectRoot, 'blob.bin'), Uint8Array.from([0, 1, 2]))
      await writeFile(join(outside, 'secret.ts'), 'secret\n')
      await symlink(join(outside, 'secret.ts'), join(projectRoot, 'escape.ts'))
      await symlink(join(projectRoot, 'src', 'a.ts'), join(projectRoot, 'alias.ts'))

      const result = await service.findExistingFiles({
        projectRoot,
        paths: [
          'src/a.ts',
          'src',
          'missing.ts',
          `../${basename(outside)}/secret.ts`,
          'escape.ts',
          'alias.ts',
          'blob.bin',
        ],
      })
      // 目录、不存在的、越出项目的（包括指向项目外的链接）都不算；二进制文件也是文件。
      assert.deepEqual(result.paths, ['src/a.ts', 'alias.ts', 'blob.bin'])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  void test('maps platform delete and undo shortcuts for the focused file tree', () => {
    const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    assert.equal(getWorkbenchFileTreeShortcutAction({ ...plain, key: 'Delete' }), 'delete-selected')
    assert.equal(
      getWorkbenchFileTreeShortcutAction({ ...plain, key: 'Backspace' }),
      'delete-selected'
    )
    assert.equal(
      getWorkbenchFileTreeShortcutAction({ ...plain, key: 'z', metaKey: true }),
      'undo-delete'
    )
    assert.equal(
      getWorkbenchFileTreeShortcutAction({ ...plain, key: 'z', ctrlKey: true }),
      'undo-delete'
    )
    assert.equal(
      getWorkbenchFileTreeShortcutAction({ ...plain, key: 'Backspace', metaKey: true }),
      null
    )
  })
})
