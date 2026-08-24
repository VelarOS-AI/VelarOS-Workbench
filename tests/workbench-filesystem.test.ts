import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'

import { AppError } from '@velaros-ai/core/error'

import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import { WorkbenchProjectFileSystem } from '../src/main/workspace/WorkbenchProjectFileSystem'
import { resolveExternalFileUnavailableStatus } from '../src/renderer/src/models/editor/workbenchEditorTabs'

const execFileAsync = promisify(execFile)

void describe('Workbench project file tree', () => {
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

  void test('restores a missing file from the preserved editor buffer, including dotfiles', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-restore-file-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-restore-data-'))
    const parts = createWorkbenchAppParts(dataRoot)

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
})
