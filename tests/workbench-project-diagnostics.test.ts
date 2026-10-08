import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { describe, test } from 'bun:test'

import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import { clearTypeScriptProjectCache } from '../src/main/workspace/language/TypeScriptProjectHost'
import {
  applyWorkbenchProjectDiagnosticsBatch,
  mergeWorkbenchDiagnosticsByPath,
  retainWorkbenchProjectDiagnostics,
} from '../src/renderer/src/models/editor/workbenchLanguageServiceInsightsModel'
import { type WorkbenchLanguageServiceDiagnostic } from '../src/shared/contracts/workbench'

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

const languagePathResolver = {
  async resolveProjectRoot(input: string): Promise<string> {
    return realpath(resolve(input))
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    return (relative(projectRoot, absolutePath) || '.').replaceAll('\\', '/')
  },
}

function diagnostic(path: string, message: string): WorkbenchLanguageServiceDiagnostic {
  return {
    path,
    severity: 'error',
    message,
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
  }
}

/** 像编辑器那样一批批查到底，把各批拼起来。 */
async function checkWholeProject(
  services: WorkbenchLanguageServices,
  request: Parameters<WorkbenchLanguageServices['getProjectDiagnostics']>[0]
): Promise<{ batches: number; checkedPaths: string[]; diagnostics: WorkbenchLanguageServiceDiagnostic[] }> {
  const checkedPaths: string[] = []
  const diagnostics: WorkbenchLanguageServiceDiagnostic[] = []
  let cursor = request.cursor
  let batches = 0
  do {
    const result = await services.getProjectDiagnostics({ ...request, cursor })
    batches += 1
    checkedPaths.push(...result.checkedPaths)
    diagnostics.push(...result.diagnostics)
    cursor = result.cursor ?? undefined
  } while (cursor && batches < 100)
  return { batches, checkedPaths, diagnostics }
}

void describe('project-wide TypeScript diagnostics', () => {
  void test('checks files that are not open, resumes from a cursor and sees unsaved edits', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-project-diagnostics-')))
    const services = new WorkbenchLanguageServices(languagePathResolver)
    try {
      await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        include: ['src'],
      }))
      await mkdir(join(projectRoot, 'src'))
      await writeFile(join(projectRoot, 'src/a.ts'), 'export const a: number = 1\n')
      await writeFile(join(projectRoot, 'src/b.ts'), "import { a } from './a'\nexport const b: string = a\n")
      await writeFile(join(projectRoot, 'src/c.ts'), 'export const c: number = "c"\n')
      await writeFile(join(projectRoot, 'notes.md'), '# not TypeScript\n')

      const full = await checkWholeProject(services, { projectRoot, anchorPaths: ['src/a.ts'] })
      assert.deepEqual(full.checkedPaths, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
      assert.deepEqual(
        full.diagnostics.map((item) => [item.path, item.code]),
        [['src/b.ts', 2322], ['src/c.ts', 2322]]
      )

      const resumed = await checkWholeProject(services, {
        projectRoot,
        anchorPaths: ['src/a.ts'],
        cursor: JSON.stringify([0, 'src/b.ts']),
      })
      assert.deepEqual(resumed.checkedPaths, ['src/c.ts'])

      // 打开着、还没保存的改动也算进去：改了 a 的类型，没打开的 b 就不报错了。
      const unsaved = await checkWholeProject(services, {
        projectRoot,
        anchorPaths: ['src/c.ts', 'notes.md'],
        openFiles: [{ path: 'src/a.ts', content: 'export const a: string = "1"\n' }],
      })
      assert.deepEqual(unsaved.diagnostics.map((item) => item.path), ['src/c.ts'])

      const none = await services.getProjectDiagnostics({ projectRoot, anchorPaths: ['notes.md'] })
      assert.deepEqual(none, { projectRoot, checkedPaths: [], diagnostics: [], cursor: null })
    } finally {
      await services.dispose()
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

void describe('Problems panel diagnostics', () => {
  void test('a batch replaces what it checked and a finished pass drops files it no longer saw', () => {
    const before = new Map([
      ['src/a.ts', [diagnostic('src/a.ts', 'old a')]],
      ['src/b.ts', [diagnostic('src/b.ts', 'old b')]],
      ['src/gone.ts', [diagnostic('src/gone.ts', 'deleted file')]],
    ])
    const batch = applyWorkbenchProjectDiagnosticsBatch(before, {
      checkedPaths: ['src/a.ts', 'src/c.ts'],
      diagnostics: [diagnostic('src/c.ts', 'new c'), diagnostic('src/c.ts', 'second c')],
    })
    assert.deepEqual([...batch.keys()], ['src/b.ts', 'src/gone.ts', 'src/c.ts'])
    assert.equal(batch.get('src/c.ts')?.length, 2)

    const retained = retainWorkbenchProjectDiagnostics(batch, new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']))
    assert.deepEqual([...retained.keys()], ['src/b.ts', 'src/c.ts'])
  })

  void test('open files show their live diagnostics, other files the project pass', () => {
    const merged = mergeWorkbenchDiagnosticsByPath({
      openDiagnosticsByPath: new Map([['src/open.ts', [diagnostic('src/open.ts', 'live')]]]),
      projectDiagnosticsByPath: new Map([
        ['src/open.ts', [diagnostic('src/open.ts', 'stale project result')]],
        ['src/closed.ts', [diagnostic('src/closed.ts', 'closed file')]],
      ]),
      openPaths: new Set(['src/open.ts']),
    })
    assert.deepEqual(
      [...merged].map(([path, items]) => [path, items.map((item) => item.message)]),
      [['src/closed.ts', ['closed file']], ['src/open.ts', ['live']]]
    )
  })
})
