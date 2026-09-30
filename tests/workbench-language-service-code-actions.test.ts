import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { applyWorkbenchLanguageServiceEditsToContent } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import type { WorkbenchLanguageServiceCodeAction } from '../src/shared/contracts'

import { createLanguageProject, rangeOf, StrictTsconfig } from './helpers/languageProject'

function titles(actions: readonly WorkbenchLanguageServiceCodeAction[]): string[] {
  return actions.map((action) => action.title)
}

function action(
  actions: readonly WorkbenchLanguageServiceCodeAction[],
  title: RegExp
): WorkbenchLanguageServiceCodeAction {
  const found = actions.find((candidate) => title.test(candidate.title))
  assert.ok(found, `no action matches ${title}: ${titles(actions).join(' | ')}`)
  return found
}

/** 把一个动作落在某个文件上的改动套到正文上。 */
function applyTo(
  content: string,
  path: string,
  changes: WorkbenchLanguageServiceCodeAction['changes']
): string {
  const change = changes.find((candidate) => candidate.path === path)
  assert.ok(change, `no edit for ${path}`)
  return applyWorkbenchLanguageServiceEditsToContent(content, change.edits)
}

void describe('TypeScript quick fixes', () => {
  void test('offer the fixes of the diagnostics under the requested range', async () => {
    const main = [
      "import { unused } from './util/values'",
      '',
      'export const total = helper() + 1',
      'export const label: string = 2',
      '',
    ].join('\n')
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/main.ts': main,
      'src/util/helper.ts': 'export function helper(): number {\n  return 1\n}\n',
      'src/util/values.ts': 'export const unused = 1\n',
    })
    try {
      const request = { projectRoot: project.projectRoot, path: 'src/main.ts', content: main, diagnostics: [] }

      const missing = await project.services.getCodeActions({ ...request, range: rangeOf(main, 'helper') })
      const addImport = action(missing.actions, /^Add import from/u)
      assert.equal(addImport.kind, 'quickfix')
      assert.equal(
        applyTo(main, 'src/main.ts', addImport.changes),
        [
          "import { helper } from './util/helper'",
          "import { unused } from './util/values'",
          '',
          'export const total = helper() + 1',
          'export const label: string = 2',
          '',
        ].join('\n')
      )
      // 只有一处「找不到名字」：不再多列一项「全部修复」。
      assert.equal(missing.actions.some((candidate) => candidate.resolve), false, titles(missing.actions).join(' | '))

      const unused = await project.services.getCodeActions({ ...request, range: rangeOf(main, 'unused') })
      assert.equal(
        applyTo(main, 'src/main.ts', action(unused.actions, /^Remove import/u).changes),
        ['', 'export const total = helper() + 1', 'export const label: string = 2', ''].join('\n')
      )

      // 光标停在没有问题的地方、或问题没有现成的修复：什么都不给。
      const clean = await project.services.getCodeActions({ ...request, range: rangeOf(main, 'total') })
      assert.deepEqual(clean.actions, [])
      const unfixable = await project.services.getCodeActions({ ...request, range: rangeOf(main, 'label') })
      assert.deepEqual(unfixable.actions, [])
    } finally {
      await project.dispose()
    }
  })

  void test('compute the diagnostics from the text in the request, not from stale editor diagnostics', async () => {
    const onDisk = 'export const base = 1\nexport const value = 1\n'
    const edited = 'export const base = 1\nexport const value = helper()\n'
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/main.ts': onDisk,
      'src/helper.ts': 'export function helper(): number {\n  return 1\n}\n',
    })
    try {
      // 编辑器里刚敲完 helper()，它的诊断还没刷新：请求里一条诊断都不带，修复照样有。
      const result = await project.services.getCodeActions({
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content: edited,
        range: rangeOf(edited, 'helper'),
        diagnostics: [],
      })
      assert.equal(
        applyTo(edited, 'src/main.ts', action(result.actions, /^Add import from/u).changes),
        "import { helper } from './helper'\n\nexport const base = 1\nexport const value = helper()\n"
      )
    } finally {
      await project.dispose()
    }
  })

  void test('offer "fix all of this kind" only when the file has more of them, and resolve it on demand', async () => {
    const main = ['export const base = 1', 'export const total = first() + second()', ''].join('\n')
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/main.ts': main,
      'src/first.ts': 'export function first(): number {\n  return 1\n}\n',
      'src/second.ts': 'export function second(): number {\n  return 2\n}\n',
    })
    try {
      const request = { projectRoot: project.projectRoot, path: 'src/main.ts', content: main }
      const range = rangeOf(main, 'first')
      const result = await project.services.getCodeActions({ ...request, range, diagnostics: [] })
      const fixAll = action(result.actions, /^Add all missing imports$/u)
      assert.deepEqual(fixAll.changes, [])
      assert.deepEqual(fixAll.resolve, { kind: 'fix-all', fixId: 'fixMissingImport' })
      // 单个修复排在前面，「全部修复」在后。
      assert.ok(
        titles(result.actions).indexOf(fixAll.title)
          > titles(result.actions).findIndex((title) => title.startsWith('Add import from')),
        titles(result.actions).join(' | ')
      )

      const resolved = await project.services.resolveCodeAction({ ...request, range, resolve: fixAll.resolve! })
      assert.deepEqual(resolved.createFiles, [])
      assert.equal(
        applyTo(main, 'src/main.ts', resolved.changes),
        [
          "import { first } from './first'",
          "import { second } from './second'",
          '',
          'export const base = 1',
          'export const total = first() + second()',
          '',
        ].join('\n')
      )
    } finally {
      await project.dispose()
    }
  })

  void test('carry edits for other files, mapped against their own text', async () => {
    const main = [
      "import { Counter } from './counter'",
      '',
      'export function run(counter: Counter): void {',
      '  counter.reset()',
      '}',
      '',
    ].join('\n')
    const counter = ['export class Counter {', '  value = 0', '  step = 1', '}', ''].join('\n')
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/main.ts': main,
      'src/counter.ts': counter,
    })
    try {
      const result = await project.services.getCodeActions({
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content: main,
        range: rangeOf(main, 'reset'),
        diagnostics: [],
      })
      const declare = action(result.actions, /^Declare method 'reset'$/u)
      assert.deepEqual(declare.changes.map((change) => change.path), ['src/counter.ts'])
      const fixed = applyTo(counter, 'src/counter.ts', declare.changes)
      assert.equal(
        fixed,
        [
          'export class Counter {',
          '  reset() {',
          "    throw new Error('Method not implemented.')",
          '  }',
          '  value = 0',
          '  step = 1',
          '}',
          '',
        ].join('\n')
      )
    } finally {
      await project.dispose()
    }
  })

  void test('indent the block a fix inserts like the four-space file it goes into', async () => {
    const main = [
      'export class Box {',
      '    size = 1',
      '}',
      '',
      'export function run(box: Box): void {',
      '    if (box.size > 0) {',
      '        box.open()',
      '    }',
      '}',
      '',
    ].join('\n')
    const project = await createLanguageProject({ 'tsconfig.json': StrictTsconfig, 'src/main.ts': main })
    try {
      const request = {
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content: main,
        range: rangeOf(main, 'open'),
        diagnostics: [],
      }
      const declared = (await project.services.getCodeActions({
        ...request,
        format: { tabSize: 4, indentSize: 4, insertSpaces: true },
      })).actions
      assert.equal(
        applyTo(main, 'src/main.ts', action(declared, /^Declare method 'open'$/u).changes),
        main.replace(
          '    size = 1\n',
          "    open() {\n        throw new Error('Method not implemented.')\n    }\n    size = 1\n"
        )
      )
    } finally {
      await project.dispose()
    }
  })

  void test('indent what a fix writes into another file like that file, not like the requesting one', async () => {
    const main = [
      "import { Counter } from './counter'",
      '',
      'export function run(counter: Counter): void {',
      '  counter.reset()',
      '}',
      '',
    ].join('\n')
    const counterWith = (unit: string): string =>
      [
        'export class Counter {',
        `${unit}value = 0`,
        '',
        `${unit}increment(): number {`,
        `${unit}${unit}this.value += 1`,
        `${unit}${unit}return this.value`,
        `${unit}}`,
        '}',
        '',
      ].join('\n')
    for (const unit of ['    ', '\t']) {
      const counter = counterWith(unit)
      const project = await createLanguageProject({
        'tsconfig.json': StrictTsconfig,
        'src/main.ts': main,
        'src/counter.ts': counter,
      })
      try {
        // 请求文件是两格缩进，被改的文件是四格 / 制表符：插进去的方法按被改的那个文件排。
        const result = await project.services.getCodeActions({
          projectRoot: project.projectRoot,
          path: 'src/main.ts',
          content: main,
          range: rangeOf(main, 'reset'),
          diagnostics: [],
          format: { tabSize: 2, indentSize: 2, insertSpaces: true },
        })
        assert.equal(
          applyTo(counter, 'src/counter.ts', action(result.actions, /^Declare method 'reset'$/u).changes),
          counter.replace(
            `${unit}value = 0\n`,
            `${unit}reset() {\n${unit}${unit}throw new Error('Method not implemented.')\n${unit}}\n${unit}value = 0\n`
          ),
          JSON.stringify(unit)
        )
      } finally {
        await project.dispose()
      }
    }
  })

  void test('write new code with the indentation, quotes and semicolons the file already uses', async () => {
    const main = [
      'import { a } from "./a";',
      '',
      'export class Box {',
      '\tsize = a;',
      '}',
      '',
      'export function run(box: Box): void {',
      '\tbox.open();',
      '\thelper();',
      '}',
      '',
    ].join('\n')
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/main.ts': main,
      'src/a.ts': 'export const a = 1;\n',
      'src/helper.ts': 'export function helper(): void {}\n',
    })
    try {
      const request = {
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content: main,
        diagnostics: [],
        format: { tabSize: 4, indentSize: 4, insertSpaces: false },
      }
      const open = await project.services.getCodeActions({ ...request, range: rangeOf(main, 'open') })
      assert.ok(
        applyTo(main, 'src/main.ts', action(open.actions, /^Declare method 'open'$/u).changes).includes(
          '\topen() {\n\t\tthrow new Error("Method not implemented.");\n\t}\n'
        ),
        applyTo(main, 'src/main.ts', action(open.actions, /^Declare method 'open'$/u).changes)
      )
      const helper = await project.services.getCodeActions({ ...request, range: rangeOf(main, 'helper') })
      assert.ok(
        applyTo(main, 'src/main.ts', action(helper.actions, /^Add import from/u).changes).startsWith(
          'import { a } from "./a";\nimport { helper } from "./helper";\n'
        )
      )
    } finally {
      await project.dispose()
    }
  })

  void test('answer nothing for files TypeScript does not serve', async () => {
    const project = await createLanguageProject({ 'notes.md': '# notes\n', 'style.css': 'a { color: red }\n' })
    try {
      for (const path of ['notes.md', 'style.css']) {
        const result = await project.services.getCodeActions({
          projectRoot: project.projectRoot,
          path,
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
          diagnostics: [],
        })
        assert.deepEqual(result.actions, [], path)
      }
      const resolved = await project.services.resolveCodeAction({
        projectRoot: project.projectRoot,
        path: 'notes.md',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        resolve: { kind: 'fix-all', fixId: 'fixMissingImport' },
      })
      assert.deepEqual([resolved.changes, resolved.createFiles], [[], []])
    } finally {
      await project.dispose()
    }
  })
})
