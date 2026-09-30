import assert from 'node:assert/strict'

import { setDiagnostics } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  buildWorkbenchCodeActionMenuRows,
  buildWorkbenchCodeMirrorChanges,
  collectWorkbenchDiagnosticsInRange,
  nextWorkbenchCodeActionRowIndex,
  partitionWorkbenchCodeActionChanges,
  resolveWorkbenchCodeActionCategories,
  resolveWorkbenchCodeActionSupport,
  resolveWorkbenchRefactorGroup,
  workbenchRangeFromOffsets,
} from '../src/renderer/src/models/editor/workbenchCodeActions'
import { mapWorkbenchDiagnosticToCodeMirror } from '../src/renderer/src/models/editor/workbenchCodeMirrorDiagnostics'
import { resolveWorkbenchEditorCommandFromKey } from '../src/renderer/src/models/editor/workbenchEditorCommands'
import { buildWorkbenchLanguageServiceEditReport } from '../src/renderer/src/models/editor/workbenchLanguageServiceEditReport'
import type {
  WorkbenchLanguageServiceCodeAction,
  WorkbenchLanguageServiceDiagnostic,
} from '../src/shared/contracts'

import { createLanguageProject, rangeOf, StrictTsconfig } from './helpers/languageProject'

const Mac = 'MacIntel'
const Linux = 'Linux x86_64'

function key(
  code: string,
  value: string,
  modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}
) {
  return {
    code,
    key: value,
    altKey: !!modifiers.alt,
    ctrlKey: !!modifiers.ctrl,
    metaKey: !!modifiers.meta,
    shiftKey: !!modifiers.shift,
  }
}

function action(title: string, extra: Partial<WorkbenchLanguageServiceCodeAction> = {}): WorkbenchLanguageServiceCodeAction {
  return { title, changes: [], ...extra }
}

const english = (messageKey: string, params?: Record<string, string | number>): string =>
  translateWorkbenchAppMessage('en-US', messageKey, params)

void describe('editor code action keys', () => {
  void test('Alt+Enter and Mod+. open the quick fix menu', () => {
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Enter', 'Enter', { alt: true }), Mac), 'quick-fix')
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('NumpadEnter', 'Enter', { alt: true }), Linux), 'quick-fix')
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Period', '.', { meta: true }), Mac), 'quick-fix')
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Period', '.', { ctrl: true }), Linux), 'quick-fix')
    // 键位不在句点上的布局：照打出来的字认。
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('KeyV', '.', { meta: true }), Mac), 'quick-fix')
  })

  void test('needs exactly the modifiers of the binding', () => {
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Enter', 'Enter'), Mac), null)
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Enter', 'Enter', { alt: true, shift: true }), Mac), null)
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Enter', 'Enter', { meta: true }), Mac), null)
    // 主修饰键跟着平台：macOS 上的 ⌃. 、别处的 Win+. 都不是。
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Period', '.', { ctrl: true }), Mac), null)
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Period', '.', { meta: true }), Linux), null)
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('Period', '.'), Linux), null)
  })

  void test('Ctrl+T on macOS and Ctrl+Alt+Shift+T elsewhere open the refactor menu', () => {
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('KeyT', 't', { ctrl: true }), Mac), 'refactor')
    // 带 Alt 的字符键只认键位：打出来的字随布局与 AltGr 变。
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyT', 'þ', { ctrl: true, alt: true, shift: true }), Linux),
      'refactor'
    )
    // 别的平台上 Ctrl+T 不占；macOS 上 ⌘T、⇧⌃T 也不是。
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('KeyT', 't', { ctrl: true }), Linux), null)
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('KeyT', 't', { meta: true }), Mac), null)
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('KeyT', 'T', { ctrl: true, shift: true }), Mac), null)
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyY', 't', { ctrl: true, alt: true, shift: true }), Linux),
      null
    )
  })

  void test('Shift+Alt+O organizes imports, whatever character the layout types for it', () => {
    // macOS 上 ⇧⌥O 打出来的是 Ø：按键位认。
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyO', 'Ø', { alt: true, shift: true }), Mac),
      'organize-imports'
    )
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyO', 'O', { alt: true, shift: true }), Linux),
      'organize-imports'
    )
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('KeyO', 'ø', { alt: true }), Mac), null)
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyO', 'O', { alt: true, shift: true, meta: true }), Mac),
      null
    )
  })
})

void describe('code action menu model', () => {
  void test('lists preferred actions first and drops exact duplicates', () => {
    const rows = buildWorkbenchCodeActionMenuRows([
      action('Add import'),
      action('Fix spelling', { preferred: true }),
      action('Add import'),
      action('Add all missing imports', { resolve: { kind: 'fix-all', fixId: 'fixMissingImport' } }),
    ])
    assert.deepEqual(
      rows.map((row) => (row.kind === 'action' ? row.action.title : row.title)),
      ['Fix spelling', 'Add import', 'Add all missing imports']
    )
    assert.equal(new Set(rows.map((row) => row.key)).size, rows.length)
  })

  void test('moves the selection over actions only and wraps around', () => {
    const rows = [
      { kind: 'header' as const, key: 'h1', title: 'Quick fixes' },
      { kind: 'action' as const, key: 'a1', action: action('one') },
      { kind: 'header' as const, key: 'h2', title: 'Refactor' },
      { kind: 'action' as const, key: 'a2', action: action('two') },
    ]
    assert.equal(nextWorkbenchCodeActionRowIndex(rows, -1, 1), 1)
    assert.equal(nextWorkbenchCodeActionRowIndex(rows, 1, 1), 3)
    assert.equal(nextWorkbenchCodeActionRowIndex(rows, 3, 1), 1)
    assert.equal(nextWorkbenchCodeActionRowIndex(rows, 1, -1), 3)
    assert.equal(nextWorkbenchCodeActionRowIndex(rows, rows.length, -1), 3)
    assert.equal(nextWorkbenchCodeActionRowIndex([rows[0]!], -1, 1), -1)
    assert.equal(nextWorkbenchCodeActionRowIndex([], -1, 1), -1)
  })

  void test('knows which files have quick fixes and which have refactorings', () => {
    const typescript = { quickFix: true, refactor: true, organizeImports: true }
    const none = { quickFix: false, refactor: false, organizeImports: false }
    assert.deepEqual(resolveWorkbenchCodeActionSupport('src/a.ts'), typescript)
    assert.deepEqual(resolveWorkbenchCodeActionSupport('src/a.jsx'), typescript)
    // 外部语言服务器只给修复。
    assert.deepEqual(resolveWorkbenchCodeActionSupport('src/a.py'), { ...none, quickFix: true })
    assert.deepEqual(resolveWorkbenchCodeActionSupport('src/a.css'), none)
    assert.deepEqual(resolveWorkbenchCodeActionSupport('README.md'), none)
    assert.deepEqual(resolveWorkbenchCodeActionSupport(null), none)
  })

  void test('asks the language service only for what the menu and the file can show', () => {
    const typescript = resolveWorkbenchCodeActionSupport('src/a.ts')
    const python = resolveWorkbenchCodeActionSupport('src/a.py')
    assert.deepEqual(resolveWorkbenchCodeActionCategories('all', typescript), ['quickfix', 'refactor'])
    assert.deepEqual(resolveWorkbenchCodeActionCategories('refactor', typescript), ['refactor'])
    assert.deepEqual(resolveWorkbenchCodeActionCategories('all', python), ['quickfix'])
    // 没有可问的：菜单不打开。
    assert.deepEqual(resolveWorkbenchCodeActionCategories('refactor', python), [])
    assert.deepEqual(resolveWorkbenchCodeActionCategories('all', resolveWorkbenchCodeActionSupport('a.css')), [])
  })

  void test('puts refactorings after the fixes, grouped by what they do', () => {
    const labels = {
      quickFixes: 'Quick fixes',
      refactors: 'Refactor',
      refactorGroups: { extract: 'Extract', inline: 'Inline', move: 'Move', rewrite: 'Rewrite', other: 'Other' },
    }
    const refactor = (title: string, kind?: string) => action(title, { category: 'refactor', kind })
    const actions = [
      action('Add import'),
      refactor('Move to a new file', 'refactor.move.newFile'),
      refactor('Extract to constant', 'refactor.extract.constant'),
      refactor('Convert to arrow function', 'refactor.rewrite.function.arrow'),
      refactor('Extract to function', 'refactor.extract.function'),
      refactor('Something else'),
    ]
    const describeRows = (rows: ReturnType<typeof buildWorkbenchCodeActionMenuRows>) =>
      rows.map((row) => (row.kind === 'header' ? `# ${row.title}` : row.action.title))

    assert.deepEqual(describeRows(buildWorkbenchCodeActionMenuRows(actions, { mode: 'all', labels })), [
      '# Quick fixes',
      'Add import',
      '# Refactor',
      'Extract to constant',
      'Extract to function',
      'Move to a new file',
      'Convert to arrow function',
      'Something else',
    ])
    // 只列重构：修复不列，每组一个标题。
    assert.deepEqual(describeRows(buildWorkbenchCodeActionMenuRows(actions, { mode: 'refactor', labels })), [
      '# Extract',
      'Extract to constant',
      'Extract to function',
      '# Move',
      'Move to a new file',
      '# Rewrite',
      'Convert to arrow function',
      '# Other',
      'Something else',
    ])
    // 只有一类、只有一组时不加标题。
    assert.deepEqual(describeRows(buildWorkbenchCodeActionMenuRows(actions.slice(0, 1), { mode: 'all', labels })), [
      'Add import',
    ])
    assert.deepEqual(describeRows(buildWorkbenchCodeActionMenuRows(actions.slice(1, 2), { mode: 'all', labels })), [
      'Move to a new file',
    ])
    assert.deepEqual(
      describeRows(buildWorkbenchCodeActionMenuRows(actions.slice(1, 2), { mode: 'refactor', labels })),
      ['Move to a new file']
    )
    const keys = buildWorkbenchCodeActionMenuRows(actions, { mode: 'refactor', labels }).map((row) => row.key)
    assert.equal(new Set(keys).size, keys.length)
  })

  void test('sorts refactoring kinds into groups', () => {
    assert.equal(resolveWorkbenchRefactorGroup('refactor.extract.type'), 'extract')
    assert.equal(resolveWorkbenchRefactorGroup('refactor.inline.variable'), 'inline')
    assert.equal(resolveWorkbenchRefactorGroup('refactor.move.newFile'), 'move')
    assert.equal(resolveWorkbenchRefactorGroup('refactor.rewrite.export.default'), 'rewrite')
    assert.equal(resolveWorkbenchRefactorGroup('refactor'), 'other')
    assert.equal(resolveWorkbenchRefactorGroup('refactor.extraction'), 'other')
    assert.equal(resolveWorkbenchRefactorGroup(undefined), 'other')
  })
})

void describe('code action edits in the editor', () => {
  void test('splits the edits between the current file and the others', () => {
    const edit = { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, newText: 'x' }
    assert.deepEqual(
      partitionWorkbenchCodeActionChanges('src/a.ts', [
        { path: 'src/a.ts', edits: [edit] },
        { path: 'src/b.ts', edits: [edit] },
        { path: 'src/empty.ts', edits: [] },
      ]),
      { current: [edit], others: [{ path: 'src/b.ts', edits: [edit] }] }
    )
  })

  void test('turns line and column ranges into sorted editor changes', () => {
    const state = EditorState.create({ doc: 'const a = 1\nconst b = a\n' })
    const changes = buildWorkbenchCodeMirrorChanges(state, [
      { range: { startLine: 2, startColumn: 11, endLine: 2, endColumn: 12 }, newText: 'total' },
      { range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 8 }, newText: 'total' },
      // 同一个位置上的两处插入保持给的先后。
      { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, newText: '// one\n' },
      { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, newText: '// two\n' },
    ])
    assert.ok(changes)
    assert.equal(
      state.update({ changes }).state.doc.toString(),
      '// one\n// two\nconst total = 1\nconst b = total\n'
    )
    // 文档末尾（最后一行之后的空行）也是合法位置。
    assert.deepEqual(
      buildWorkbenchCodeMirrorChanges(state, [
        { range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 }, newText: 'export {}\n' },
      ]),
      [{ from: 24, to: 24, insert: 'export {}\n' }]
    )
  })

  void test('refuses edits that do not fit the current text', () => {
    const state = EditorState.create({ doc: 'const a = 1\n' })
    const range = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({
      range: { startLine, startColumn, endLine, endColumn },
      newText: 'x',
    })
    // 行、列落在文档之外；前后颠倒；互相重叠。
    assert.equal(buildWorkbenchCodeMirrorChanges(state, [range(5, 1, 5, 2)]), null)
    assert.equal(buildWorkbenchCodeMirrorChanges(state, [range(1, 40, 1, 41)]), null)
    assert.equal(buildWorkbenchCodeMirrorChanges(state, [range(1, 0, 1, 2)]), null)
    assert.equal(buildWorkbenchCodeMirrorChanges(state, [range(1, 5, 1, 2)]), null)
    assert.equal(buildWorkbenchCodeMirrorChanges(state, [range(1, 1, 1, 6), range(1, 4, 1, 8)]), null)
    assert.deepEqual(buildWorkbenchCodeMirrorChanges(state, []), [])
  })

  void test('reports the diagnostics under a range at their current position', () => {
    const initial = EditorState.create({ doc: 'let a = 1\nlet b = missing\n' })
    const diagnostics: WorkbenchLanguageServiceDiagnostic[] = [
      {
        path: 'src/a.ts',
        severity: 'error',
        message: "Cannot find name 'missing'.",
        source: 'typescript',
        code: 2304,
        range: { startLine: 2, startColumn: 9, endLine: 2, endColumn: 16 },
      },
      {
        path: 'src/a.ts',
        severity: 'warning',
        message: 'prefer const',
        source: 'eslint',
        code: 'prefer-const',
        range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 6 },
      },
    ]
    const withDiagnostics = initial.update(
      setDiagnostics(
        initial,
        diagnostics.flatMap((diagnostic) => {
          const mapped = mapWorkbenchDiagnosticToCodeMirror(initial, diagnostic)
          return mapped ? [mapped] : []
        })
      )
    ).state
    // 在文件开头插了一行：诊断跟着下移，交给语言服务的范围按现在的正文算。
    const state = withDiagnostics.update({ changes: { from: 0, insert: '// header\n' } }).state
    const offset = state.doc.toString().indexOf('missing')

    assert.deepEqual(collectWorkbenchDiagnosticsInRange(state, offset + 2, offset + 2), [
      { ...diagnostics[0]!, range: { startLine: 3, startColumn: 9, endLine: 3, endColumn: 16 } },
    ])
    // 选区盖住两行：两条都在。
    assert.deepEqual(
      collectWorkbenchDiagnosticsInRange(state, 0, state.doc.length).map((diagnostic) => diagnostic.code),
      ['prefer-const', 2304]
    )
    assert.deepEqual(collectWorkbenchDiagnosticsInRange(state, 0, 3), [])
    assert.deepEqual(workbenchRangeFromOffsets(state, offset + 7, offset), {
      startLine: 3,
      startColumn: 9,
      endLine: 3,
      endColumn: 16,
    })
  })

  void test('a fix from the TypeScript service lands in the editor as one change set', async () => {
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
      const listed = await project.services.getCodeActions({ ...request, range, diagnostics: [] })
      const fixAll = buildWorkbenchCodeActionMenuRows(listed.actions).flatMap((row) =>
        row.kind === 'action' && row.action.resolve ? [row.action] : []
      )[0]
      assert.ok(fixAll)
      const resolved = await project.services.resolveCodeAction({ ...request, range, resolve: fixAll.resolve! })

      const state = EditorState.create({ doc: main })
      const { current, others } = partitionWorkbenchCodeActionChanges('src/main.ts', resolved.changes)
      assert.deepEqual(others, [])
      const changes = buildWorkbenchCodeMirrorChanges(state, current)
      assert.ok(changes)
      assert.equal(
        state.update({ changes }).state.doc.toString(),
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
})

void describe('reporting language service edits', () => {
  void test('a fix that only touched the file in front of the user says nothing', () => {
    assert.equal(
      buildWorkbenchLanguageServiceEditReport(
        { changedFiles: 0, failures: [] },
        { kind: 'code-action', editedInEditor: 1, translate: english }
      ),
      null
    )
  })

  void test('a fix that touched other files or created files says how many', () => {
    assert.deepEqual(
      buildWorkbenchLanguageServiceEditReport(
        { changedFiles: 2, failures: [] },
        { kind: 'code-action', editedInEditor: 1, translate: english }
      ),
      { tone: 'success', title: 'Files changed: 3', description: undefined }
    )
    assert.deepEqual(
      buildWorkbenchLanguageServiceEditReport(
        { changedFiles: 0, failures: [], createdPaths: ['src/compute.ts'] },
        { kind: 'code-action', editedInEditor: 1, translate: english }
      ),
      { tone: 'success', title: 'Files changed: 2', description: 'created src/compute.ts' }
    )
  })

  void test('files that could not be changed are named with the reason', () => {
    assert.deepEqual(
      buildWorkbenchLanguageServiceEditReport(
        {
          changedFiles: 1,
          failures: [
            { path: 'dist/a.ts', reason: 'read-only' },
            { path: 'src/b.ts', reason: 'error', message: 'disk full' },
          ],
        },
        { kind: 'code-action', editedInEditor: 1, translate: english }
      ),
      {
        tone: 'warning',
        title: 'Files changed: 2; some files were not changed',
        description: 'dist/a.ts: the file is read-only; src/b.ts: disk full',
      }
    )
  })

  void test('a rename always reports, as before', () => {
    assert.deepEqual(
      buildWorkbenchLanguageServiceEditReport(
        { changedFiles: 0, failures: [] },
        { kind: 'rename', editedInEditor: 1, translate: english }
      ),
      { tone: 'success', title: 'Renamed in 1 files', description: undefined }
    )
  })

  void test('every message exists in both languages', () => {
    for (const messageKey of [
      'workbench.editorContextQuickFix',
      'workbench.editorCodeActionsTitle',
      'workbench.editorCodeActionsLoading',
      'workbench.editorCodeActionsEmpty',
      'workbench.languageServiceActionApplied',
      'workbench.languageServiceActionPartial',
      'workbench.languageServiceActionCreatedFile',
      'workbench.languageServiceActionStale',
      'workbench.languageServiceActionFailed',
      'workbench.editorContextRefactor',
      'workbench.editorContextOrganizeImports',
      'workbench.editorCodeActionsQuickFixGroup',
      'workbench.editorCodeActionsRefactorGroup',
      'workbench.editorRefactorsLoading',
      'workbench.editorRefactorsEmpty',
      'workbench.editorRefactorGroupExtract',
      'workbench.editorRefactorGroupInline',
      'workbench.editorRefactorGroupMove',
      'workbench.editorRefactorGroupRewrite',
      'workbench.editorRefactorGroupOther',
    ]) {
      for (const locale of ['zh-CN', 'en-US'] as const)
        assert.notEqual(translateWorkbenchAppMessage(locale, messageKey), messageKey, `${locale} ${messageKey}`)
    }
  })
})
