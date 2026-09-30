import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { Result } from '@velaros-ai/core/result'

import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import {
  createWorkbenchLanguageServiceFiles,
  type WorkbenchLanguageServiceFileCreationPorts,
} from '../src/renderer/src/models/editor/workbenchLanguageServiceFileChanges'

import { refuseTrash } from './helpers/fakeTrash'
import {
  applyFileEdits,
  createLanguageProject,
  findCodeAction,
  rangeOf,
  StrictTsconfig,
} from './helpers/languageProject'

const Main = [
  "import { alpha } from './util/alpha'",
  '',
  'export function compute(a: number, b: number): number {',
  '  const total = a + b',
  '  return total + alpha',
  '}',
  '',
  'export const result = compute(1, 2)',
  '',
].join('\n')
const ComputeFunction = [
  'export function compute(a: number, b: number): number {',
  '  const total = a + b',
  '  return total + alpha',
  '}',
].join('\n')

void describe('files created by a language service edit', () => {
  void test('"move to a new file" creates the file through the file pipeline and leaves a project that type-checks', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/main.ts': Main,
      'src/util/alpha.ts': 'export const alpha = 1\n',
    })
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-created-files-data-'))
    const parts = createWorkbenchAppParts(dataRoot, { moveToTrash: refuseTrash })
    const { projectRoot } = project
    // 与编辑器用的是同一对主进程入口：文件树的「新建」与保存管线。
    const ports: WorkbenchLanguageServiceFileCreationPorts = {
      createEntry: (request) => Result.wrap(() => parts.files.createEntry({ projectRoot, ...request })),
      saveFile: (request) => Result.wrap(() => parts.files.saveFile({ projectRoot, ...request })),
    }
    try {
      const request = { projectRoot, path: 'src/main.ts', content: Main, range: rangeOf(Main, ComputeFunction) }
      const listed = await project.services.getCodeActions({ ...request, diagnostics: [], categories: ['refactor'] })
      const resolved = await project.services.resolveCodeAction({
        ...request,
        resolve: findCodeAction(listed.actions, /^Move to a new file$/u).resolve!,
      })
      assert.deepEqual(resolved.createFiles.map((file) => file.path), ['src/compute.ts'])

      const created = await createWorkbenchLanguageServiceFiles(resolved.createFiles, ports)
      assert.deepEqual(created, { createdPaths: ['src/compute.ts'], parentPaths: ['src'], failures: [] })
      assert.equal(
        await project.read('src/compute.ts'),
        ["import { alpha } from './util/alpha'", '', '', ComputeFunction, ''].join('\n')
      )

      // 当前文件那部分由编辑器套：挪走的函数换成了从新文件导入，整个项目照样通过类型检查。
      const mainAfter = applyFileEdits(Main, 'src/main.ts', resolved.changes)
      assert.ok(mainAfter.includes("import { compute } from './compute'"), mainAfter)
      assert.ok(!mainAfter.includes('function compute'), mainAfter)
      await project.services.projectFilesChanged({ projectRoot, paths: ['src/compute.ts'] })
      for (const [path, content] of [
        ['src/main.ts', mainAfter],
        ['src/compute.ts', await project.read('src/compute.ts')],
      ] as const) {
        const diagnostics = await project.services.getDiagnostics({ projectRoot, path, content })
        assert.deepEqual(
          diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
          [],
          path
        )
      }

      // 同名文件已经在了：不覆盖，报出来；别的照建。
      const again = await createWorkbenchLanguageServiceFiles(
        [
          { path: 'src/compute.ts', content: 'overwritten\n' },
          { path: 'notes.txt', content: 'kept\n' },
          { path: 'src/empty.ts', content: '' },
        ],
        ports
      )
      assert.deepEqual(again.createdPaths, ['notes.txt', 'src/empty.ts'])
      assert.deepEqual(again.parentPaths, ['.', 'src'])
      assert.deepEqual(again.failures.map((failure) => [failure.path, failure.reason]), [
        ['src/compute.ts', 'error'],
      ])
      assert.ok(again.failures[0]?.message)
      assert.ok((await project.read('src/compute.ts')).includes('export function compute'))
      assert.equal(await project.read('notes.txt'), 'kept\n')
      assert.equal(await project.read('src/empty.ts'), '')
    } finally {
      await project.dispose()
      await rm(dataRoot, { recursive: true, force: true })
    }
  })
})
