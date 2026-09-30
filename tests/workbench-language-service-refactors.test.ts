import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { WorkbenchLanguageServiceRange } from '../src/shared/contracts'

import {
  applyFileEdits,
  createLanguageProject,
  findCodeAction,
  type LanguageProjectFixture,
  rangeOf,
  StrictTsconfig,
} from './helpers/languageProject'

const Main = [
  "import { alpha } from './util/alpha'",
  '',
  'export function compute(a: number, b: number): number {',
  '  const total = a + b',
  '  const doubled = total * 2',
  '  return doubled + alpha',
  '}',
  '',
  'export function describe(point: { x: number; y: number }): string {',
  '  return String(point.x + point.y)',
  '}',
  '',
].join('\n')
const ComputeFunction = [
  'export function compute(a: number, b: number): number {',
  '  const total = a + b',
  '  const doubled = total * 2',
  '  return doubled + alpha',
  '}',
].join('\n')
const Files = {
  'tsconfig.json': StrictTsconfig,
  'src/main.ts': Main,
  'src/util/alpha.ts': 'export const alpha = 1\n',
}

function refactorsAt(project: LanguageProjectFixture, content: string, range: WorkbenchLanguageServiceRange) {
  return project.services.getCodeActions({
    projectRoot: project.projectRoot,
    path: 'src/main.ts',
    content,
    range,
    diagnostics: [],
    categories: ['refactor'],
  })
}

/** 在 `range` 上找标题对得上的重构，选中它，返回算出来的改动。 */
async function resolveRefactor(
  project: LanguageProjectFixture,
  content: string,
  range: WorkbenchLanguageServiceRange,
  title: RegExp,
  format?: { tabSize: number; indentSize: number; insertSpaces: boolean }
) {
  const listed = await refactorsAt(project, content, range)
  return project.services.resolveCodeAction({
    projectRoot: project.projectRoot,
    path: 'src/main.ts',
    content,
    range,
    resolve: findCodeAction(listed.actions, title).resolve!,
    format,
  })
}

void describe('TypeScript refactorings', () => {
  void test('are listed for the selection only when asked for, and carry no edits until chosen', async () => {
    const project = await createLanguageProject(Files)
    try {
      const request = {
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content: Main,
        range: rangeOf(Main, 'a + b'),
        diagnostics: [],
      }
      // 不说要哪几类：只有快速修复（诊断浮层问的就是这个）。这里没有问题，所以是空的。
      assert.deepEqual((await project.services.getCodeActions(request)).actions, [])

      const refactors = (await refactorsAt(project, Main, request.range)).actions
      for (const refactor of refactors) {
        assert.equal(refactor.category, 'refactor')
        assert.deepEqual(refactor.changes, [])
        assert.equal(refactor.resolve?.kind, 'refactor')
      }
      assert.deepEqual(
        [
          findCodeAction(refactors, /^Extract to constant in enclosing scope$/u).kind,
          findCodeAction(refactors, /^Extract to function in module scope$/u).kind,
          findCodeAction(refactors, /^Move to a new file$/u).kind,
        ],
        ['refactor.extract.constant', 'refactor.extract.function', 'refactor.move.newFile']
      )
      // 要再问用户一步的（移到某个已有文件，得挑目标）不列。
      assert.equal(refactors.some((refactor) => /^Move to file$/u.test(refactor.title)), false)

      // 两类一起要：修复在前，重构在后。选中的语句里有个没用到的变量（有修复），整句也能抽成函数（有重构）。
      const unused = Main.replace('const doubled = total * 2', 'const doubled = a * 2')
      const both = (await project.services.getCodeActions({
        ...request,
        content: unused,
        range: rangeOf(unused, 'const total = a + b'),
        categories: ['quickfix', 'refactor'],
      })).actions
      const categories = both.map((candidate) => candidate.category ?? 'quickfix')
      assert.ok(categories.includes('quickfix') && categories.includes('refactor'), categories.join(','))
      assert.ok(categories.lastIndexOf('quickfix') < categories.indexOf('refactor'))
    } finally {
      await project.dispose()
    }
  })

  void test('extract a constant and say where the new name is so it can be renamed', async () => {
    const project = await createLanguageProject(Files)
    try {
      const resolved = await resolveRefactor(
        project,
        Main,
        rangeOf(Main, 'a + b'),
        /^Extract to constant in enclosing scope$/u
      )
      assert.deepEqual(resolved.createFiles, [])
      const after = applyFileEdits(Main, 'src/main.ts', resolved.changes)
      assert.equal(
        after,
        Main.replace('  const total = a + b', '  const newLocal = a + b\n  const total = newLocal')
      )

      // 改名的位置按套完改动之后的正文算，指着新名字。
      const location = resolved.renameLocation
      assert.ok(location)
      assert.equal(after.slice(location.offset, location.offset! + 'newLocal'.length), 'newLocal')
      assert.ok(after.split('\n')[location.line - 1]!.slice(location.column - 1).startsWith('newLocal'))
    } finally {
      await project.dispose()
    }
  })

  void test('extract a function, extract a type and inline a variable', async () => {
    const project = await createLanguageProject(Files)
    try {
      const extracted = await resolveRefactor(
        project,
        Main,
        rangeOf(Main, 'total * 2'),
        /^Extract to function in module scope$/u
      )
      const withFunction = applyFileEdits(Main, 'src/main.ts', extracted.changes)
      assert.ok(withFunction.includes('const doubled = newFunction(total)'), withFunction)
      assert.ok(
        withFunction.includes('\nfunction newFunction(total: number) {\n  return total * 2\n}\n'),
        withFunction
      )
      assert.ok(extracted.renameLocation)

      const typed = await resolveRefactor(
        project,
        Main,
        rangeOf(Main, '{ x: number; y: number }'),
        /^Extract to type alias$/u
      )
      const withType = applyFileEdits(Main, 'src/main.ts', typed.changes)
      assert.ok(withType.includes('export function describe(point: NewType): string'), withType)
      assert.ok(withType.includes('type NewType = {'), withType)

      // 光标停在变量名上、没有选区：内联变量。
      const name = rangeOf(Main, 'doubled')
      const inlined = await resolveRefactor(
        project,
        Main,
        { ...name, endLine: name.startLine, endColumn: name.startColumn },
        /^Inline variable$/u
      )
      assert.equal(
        applyFileEdits(Main, 'src/main.ts', inlined.changes),
        Main.replace('  const doubled = total * 2\n', '').replace(
          'return doubled + alpha',
          'return total * 2 + alpha'
        )
      )
      assert.equal(inlined.renameLocation, undefined)
    } finally {
      await project.dispose()
    }
  })

  void test('moving to a new file returns the file to create, written like the file it came from', async () => {
    const project = await createLanguageProject(Files)
    try {
      const resolved = await resolveRefactor(
        project,
        Main,
        rangeOf(Main, ComputeFunction),
        /^Move to a new file$/u
      )
      // 新文件与原文件同一个目录，名字取被挪走的函数名；原文件不写分号，新文件也不写。
      assert.deepEqual(resolved.createFiles, [
        {
          path: 'src/compute.ts',
          content: ["import { alpha } from './util/alpha'", '', '', ComputeFunction, ''].join('\n'),
        },
      ])
      const remaining = applyFileEdits(Main, 'src/main.ts', resolved.changes)
      assert.ok(!remaining.includes('function compute'), remaining)
      assert.ok(remaining.includes('export function describe'), remaining)
      assert.ok(!remaining.includes("from './util/alpha'"), remaining)

      // 原文件写分号、四格缩进：新文件照着来。
      const withSemicolons = Main.replaceAll('  ', '    ')
        .replace("'./util/alpha'", "'./util/alpha';")
        .replace('a + b', 'a + b;')
        .replace('total * 2', 'total * 2;')
        .replace('doubled + alpha', 'doubled + alpha;')
        .replace('point.y)', 'point.y);')
      const computeWithSemicolons = ComputeFunction.replaceAll('  ', '    ')
        .replace('a + b', 'a + b;')
        .replace('total * 2', 'total * 2;')
        .replace('doubled + alpha', 'doubled + alpha;')
      const moved = await resolveRefactor(
        project,
        withSemicolons,
        rangeOf(withSemicolons, computeWithSemicolons),
        /^Move to a new file$/u,
        { tabSize: 4, indentSize: 4, insertSpaces: true }
      )
      assert.equal(
        moved.createFiles[0]?.content,
        ["import { alpha } from './util/alpha';", '', '', computeWithSemicolons, ''].join('\n')
      )
    } finally {
      await project.dispose()
    }
  })

  void test('are only offered by the TypeScript service', async () => {
    const project = await createLanguageProject({ 'notes.md': '# notes\n\nsome text\n' })
    try {
      const result = await project.services.getCodeActions({
        projectRoot: project.projectRoot,
        path: 'notes.md',
        content: '# notes\n\nsome text\n',
        range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 5 },
        diagnostics: [],
        categories: ['refactor'],
      })
      assert.deepEqual(result.actions, [])
    } finally {
      await project.dispose()
    }
  })
})
