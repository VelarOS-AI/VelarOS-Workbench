import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import { clearTypeScriptProjectCache } from '../src/main/workspace/language/TypeScriptProjectHost'
import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import { writeWorkbenchLanguageServiceFileChange } from '../src/renderer/src/models/editor/workbenchLanguageServiceFileChanges'
import { type WorkbenchReadFileResult } from '../src/shared/contracts/workbench'

import { refuseTrash } from './helpers/fakeTrash'

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

const languagePathResolver = {
  async resolveProjectRoot(input: string): Promise<string> {
    return realpath(resolve(input))
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath))
      throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    return (relative(projectRoot, absolutePath) || '.').replaceAll('\\', '/')
  },
}

function diskFile(
  content: string,
  overrides: Partial<WorkbenchReadFileResult> = {}
): WorkbenchReadFileResult {
  return {
    projectRoot: '/project',
    path: 'src/a.ts',
    content,
    encoding: 'utf-8',
    eol: 'lf',
    size: content.length,
    modifiedAt: 1_000,
    totalLines: content.split('\n').length,
    truncated: false,
    ...overrides,
  }
}

const renameEdit = {
  path: 'src/a.ts',
  edits: [
    { range: { startLine: 1, startColumn: 14, endLine: 1, endColumn: 19 }, newText: 'total' },
  ],
}

void describe('language service edits for files that are not open', () => {
  void test('are written through the save pipeline with the version that was read', async () => {
    const saved: unknown[] = []
    const failure = await writeWorkbenchLanguageServiceFileChange(renameEdit, {
      readFile: async () => diskFile('export const count = 1\n'),
      saveFile: async (request) => {
        saved.push(request)
        return Result.ok(diskFile(request.content))
      },
    })
    assert.equal(failure, null)
    // 不带编码与换行符：写回时沿用磁盘上的格式。
    assert.deepEqual(saved, [
      {
        path: 'src/a.ts',
        content: 'export const total = 1\n',
        expectedModifiedAt: 1_000,
        expectedSize: 'export const count = 1\n'.length,
      },
    ])
  })

  void test('the rename report is translated in both languages', () => {
    for (const key of [
      'workbench.languageServiceEditsApplied',
      'workbench.languageServiceEditsPartial',
      'workbench.languageServiceEditFailedFile',
      'workbench.languageServiceEditFailureSeparator',
      'workbench.languageServiceEditReadOnly',
      'workbench.languageServiceEditUnsupportedText',
      'workbench.languageServiceEditChangedOnDisk',
    ]) {
      const zh = translateWorkbenchAppMessage('zh-CN', key, { count: 3, path: 'a.ts', reason: 'x' })
      const en = translateWorkbenchAppMessage('en-US', key, { count: 3, path: 'a.ts', reason: 'x' })
      assert.notEqual(en, key, `en-US is missing ${key}`)
      assert.notEqual(zh, key, `zh-CN is missing ${key}`)
    }
    assert.equal(
      translateWorkbenchAppMessage('en-US', 'workbench.languageServiceEditsApplied', { count: 3 }),
      'Renamed in 3 files'
    )
  })

  void test('report read-only, unsupported, conflicting and failing files instead of skipping them', async () => {
    const save = async () => Result.ok(diskFile(''))
    const cases = [
      [diskFile('export const count = 1\n', { gitIgnored: true }), save, 'read-only'],
      [diskFile('export const count = 1\n', { truncated: true }), save, 'unsupported-text'],
      [diskFile('export const count = 1\n', { textIssue: 'mixed-eol' }), save, 'unsupported-text'],
      [
        diskFile('export const count = 1\n'),
        async () => Result.fail(new AppError('CONFLICT', 'changed')),
        'changed-on-disk',
      ],
      [
        diskFile('export const count = 1\n'),
        async () => Result.fail(new AppError('IPC', 'disk full')),
        'error',
      ],
    ] as const
    for (const [file, saveFile, reason] of cases) {
      const failure = await writeWorkbenchLanguageServiceFileChange(renameEdit, {
        readFile: async () => file,
        saveFile,
      })
      assert.equal(failure?.reason, reason, JSON.stringify(file))
    }

    const unreadable = await writeWorkbenchLanguageServiceFileChange(renameEdit, {
      readFile: async () => {
        throw new AppError('NOT_FOUND', 'gone')
      },
      saveFile: save,
    })
    assert.deepEqual(unreadable, { path: 'src/a.ts', reason: 'error', message: 'gone' })
  })

  void test('rename a symbol across a closed CRLF + BOM file on disk and keep its format', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-rename-closed-')))
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-rename-data-'))
    const services = new WorkbenchLanguageServices(languagePathResolver)
    const parts = createWorkbenchAppParts(dataRoot, { moveToTrash: refuseTrash })
    try {
      await writeFile(
        join(projectRoot, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] })
      )
      await mkdir(join(projectRoot, 'src'))
      await writeFile(
        join(projectRoot, 'src/count.ts'),
        '﻿export const count = 1\r\nexport const twice = count * 2\r\n'
      )
      const main = "import { count } from './count'\nconsole.log(count)\n"
      await writeFile(join(projectRoot, 'src/main.ts'), main)

      const rename = await services.getRename({
        projectRoot,
        path: 'src/main.ts',
        content: main,
        position: { line: 2, column: 13 },
        newName: 'total',
      })
      const closed = rename.changes.find((change) => change.path === 'src/count.ts')
      assert.ok(closed, JSON.stringify(rename.changes))

      const failure = await writeWorkbenchLanguageServiceFileChange(closed, {
        readFile: (path) => parts.files.readFile({ projectRoot, path, maxChars: 1_000_000 }),
        saveFile: (request) => Result.wrap(() => parts.files.saveFile({ projectRoot, ...request })),
      })
      assert.equal(failure, null)
      assert.equal(
        await readFile(join(projectRoot, 'src/count.ts'), 'utf8'),
        '﻿export const total = 1\r\nexport const twice = total * 2\r\n'
      )

      // 标准库里的符号不改名：不然会连依赖的声明文件一起改。
      const library = await services.getRename({
        projectRoot,
        path: 'src/main.ts',
        content: main,
        position: { line: 2, column: 3 },
        newName: 'logger',
      })
      assert.deepEqual(library.changes, [])
    } finally {
      await services.dispose()
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  })
})
