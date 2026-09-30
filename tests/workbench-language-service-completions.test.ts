import assert from 'node:assert/strict'

import { autocompletion, type Completion, type CompletionResult } from '@codemirror/autocomplete'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import {
  buildWorkbenchLanguageServiceCompletionResult,
  requestWorkbenchLanguageServiceCompletions,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageServiceCompletions'
import { convertWorkbenchLspSnippet } from '../src/renderer/src/models/editor/workbenchLanguageServiceSnippet'
import type {
  WorkbenchLanguageServiceCompletionItem,
  WorkbenchLanguageServiceCompletionTextEdit,
} from '../src/shared/contracts'

/** 只有 state 与 dispatch 的编辑器替身：补全的 apply 只用到这两样。 */
class FakeEditorView {
  public constructor(public state: EditorState) {}

  public dispatch(spec: TransactionSpec): void {
    this.state = this.state.update(spec).state
  }

  /** 模拟用户在光标处打字；已经给出的补全结果按 CodeMirror 的方式跟着换算。 */
  public type(text: string, result: CompletionResult): void {
    const head = this.state.selection.main.head
    const transaction = this.state.update({
      changes: { from: head, insert: text },
      selection: EditorSelection.cursor(head + text.length),
    })
    result.map?.(result, transaction.changes)
    this.state = transaction.state
  }
}

/** `§` 标出光标。 */
function stateWithCursor(text: string): EditorState {
  const cursor = text.indexOf('§')
  return EditorState.create({
    doc: text.replace('§', ''),
    selection: { anchor: cursor },
    extensions: [autocompletion()],
  })
}

function completionResult(
  state: EditorState,
  path: string,
  items: WorkbenchLanguageServiceCompletionItem[],
  options: {
    isIncomplete?: boolean
    resolve?: (item: unknown) => Promise<{ additionalTextEdits: WorkbenchLanguageServiceCompletionTextEdit[] }>
  } = {}
): CompletionResult {
  const result = buildWorkbenchLanguageServiceCompletionResult({
    state,
    position: state.selection.main.head,
    path,
    result: { items, isIncomplete: options.isIncomplete },
    resolve: options.resolve ?? null,
  })
  assert.ok(result)
  return result
}

/** 按 CodeMirror 接受补全的方式调用 apply（from 是结果的起点，to 是光标）。 */
function accept(view: FakeEditorView, result: CompletionResult, label: string): void {
  const option = result.options.find((candidate) => (candidate.displayLabel ?? candidate.label) === label)
  assert.ok(option, `missing ${label}`)
  const from = result.from
  const to = view.state.selection.main.head
  if (typeof option.apply === 'string') {
    view.dispatch({ changes: { from, to, insert: option.apply } })
    return
  }
  const apply = option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void
  apply(view as unknown as EditorView, option, from, to)
}

function range(startLine: number, startColumn: number, endLine: number, endColumn: number) {
  return { startLine, startColumn, endLine, endColumn }
}

void describe('LSP snippets become CodeMirror snippets', () => {
  void test('tab stops, placeholders, choices and the final cursor', () => {
    assert.deepEqual(convertWorkbenchLspSnippet('color: $0;'), {
      template: 'color: ${0};',
      text: 'color: ;',
      hasFields: false,
      hasTabStops: true,
    })
    assert.equal(convertWorkbenchLspSnippet('class="$1"').template, 'class="${1}"')
    assert.deepEqual(convertWorkbenchLspSnippet('rgb(${1:red}, ${2:green}, ${3|blue,navy|})'), {
      template: 'rgb(${1:red}, ${2:green}, ${3:blue})',
      text: 'rgb(red, green, blue)',
      hasFields: true,
      hasTabStops: true,
    })
    // 同号占位符沿用第一处的默认文字；嵌套的占位符摊平成默认文字。
    assert.equal(
      convertWorkbenchLspSnippet('${1:name} = ${1}; ${2:foo ${3:bar}}$0').template,
      '${1:name} = ${1:name}; ${2:foo bar}${0}'
    )
    assert.equal(convertWorkbenchLspSnippet('plain text').hasTabStops, false)
  })

  void test('literal dollars, braces and variables', () => {
    const converted = convertWorkbenchLspSnippet('\\$price #{x} {a} ${TM_SELECTED_TEXT:sel} $TM_FILENAME \\}')
    assert.equal(converted.text, '$price #{x} {a} sel  }')
    assert.equal(converted.template, '$price #\\{x\\} \\{a\\} sel  \\}')
    assert.equal(converted.hasTabStops, false)
  })
})

void describe('language service completions in CodeMirror', () => {
  void test('keeps every item and filters only on extensions of the word typed so far', () => {
    const state = stateWithCursor('document.qu§')
    const items = Array.from({ length: 300 }, (_, index) => ({ label: `member${index}` }))
    items.push({ label: 'querySelector' })
    const result = completionResult(state, 'src/main.ts', items)

    assert.equal(result.options.length, 301)
    assert.equal(result.from, 'document.'.length)
    const validFor = result.validFor as (text: string) => boolean
    assert.equal(validFor('qu'), true)
    assert.equal(validFor('quer'), true)
    // 词变短了、变成别的东西了：重新请求。
    assert.equal(validFor('q'), false)
    assert.equal(validFor('qu.'), false)
    assert.equal(validFor('qu-x'), false)

    const incomplete = completionResult(state, 'src/main.ts', items, { isIncomplete: true })
    assert.equal(incomplete.validFor, undefined)
  })

  void test('CSS and HTML words include hyphens', () => {
    const css = completionResult(stateWithCursor('a { border-t§ }'), 'styles/app.css', [{ label: 'border-top' }])
    assert.equal(css.from, 'a { '.length)
    const ts = completionResult(stateWithCursor('a - b§'), 'src/main.ts', [{ label: 'bar' }])
    assert.equal(ts.from, 'a - '.length)
  })

  void test('replaces the TypeScript replacement span instead of only the word', () => {
    const optional = new FakeEditorView(stateWithCursor('declare const o: { foo: number } | undefined\no.§'))
    const optionalResult = completionResult(optional.state, 'src/main.ts', [
      { label: 'foo', insertText: '?.foo', range: range(2, 2, 2, 3) },
    ])
    accept(optional, optionalResult, 'foo')
    assert.equal(optional.state.doc.line(2).text, 'o?.foo')

    const statement = new FakeEditorView(stateWithCursor('import useTh§'))
    const statementResult = completionResult(statement.state, 'src/main.ts', [{
      label: 'useTheme',
      insertText: "import { useTheme$1 } from './theme';",
      isSnippet: true,
      range: range(1, 1, 1, 13),
    }])
    statement.type('e', statementResult)
    accept(statement, statementResult, 'useTheme')
    assert.equal(statement.state.doc.toString(), "import { useTheme } from './theme';")
    // 光标停在 `$1`：花括号里名字后面。
    assert.equal(statement.state.selection.main.head, 'import { useTheme'.length)
  })

  void test('expands CSS and HTML snippets with the cursor on the tab stop', () => {
    const css = new FakeEditorView(stateWithCursor('a { col§ }'))
    const cssResult = completionResult(css.state, 'styles/app.css', [{
      label: 'color',
      insertText: 'color: $0;',
      isSnippet: true,
      range: range(1, 5, 1, 8),
      retrigger: true,
    }])
    accept(css, cssResult, 'color')
    assert.equal(css.state.doc.toString(), 'a { color: ; }')
    assert.equal(css.state.selection.main.head, 'a { color: '.length)

    const html = new FakeEditorView(stateWithCursor('<div cla§></div>'))
    const htmlResult = completionResult(html.state, 'index.html', [{
      label: 'class',
      insertText: 'class="$1"',
      isSnippet: true,
      range: range(1, 6, 1, 9),
    }])
    accept(html, htmlResult, 'class')
    assert.equal(html.state.doc.toString(), '<div class=""></div>')
    assert.equal(html.state.selection.main.head, '<div class="'.length)

    // 关闭标签的替换范围从词首前的 `/` 开始：比对用去掉它的文字，写入时连 `/` 一起换掉。
    const close = new FakeEditorView(stateWithCursor('<div></§'))
    const closeResult = completionResult(close.state, 'index.html', [{
      label: '/div',
      filterText: '/div',
      insertText: '/div>',
      range: range(1, 7, 1, 8),
    }])
    assert.equal(closeResult.options[0]?.label, 'div')
    accept(close, closeResult, '/div')
    assert.equal(close.state.doc.toString(), '<div></div>')
  })

  void test('applies an import from the completion in the same change, even after more typing', () => {
    const view = new FakeEditorView(stateWithCursor('import os\nPa§\n'))
    const result = completionResult(view.state, 'main.py', [{
      label: 'Path',
      insertText: 'Path',
      range: range(2, 1, 2, 3),
      additionalTextEdits: [{ path: 'main.py', range: range(1, 1, 1, 1), newText: 'from pathlib import Path\n' }],
    }])
    view.type('t', result)
    accept(view, result, 'Path')
    assert.equal(view.state.doc.toString(), 'from pathlib import Path\nimport os\nPath\n')
    assert.equal(view.state.selection.main.head, 'from pathlib import Path\nimport os\nPath'.length)
  })

  void test('adds a TypeScript auto-import that is resolved after the completion was accepted', async () => {
    const view = new FakeEditorView(stateWithCursor('const a = 1\nuseThe§'))
    let resolveEdits!: (value: { additionalTextEdits: WorkbenchLanguageServiceCompletionTextEdit[] }) => void
    const requested: unknown[] = []
    const result = completionResult(view.state, 'src/main.ts', [{
      label: 'useTheme',
      insertText: 'useTheme',
      resolve: { name: 'useTheme', source: './theme' },
    }], {
      resolve: (item) => {
        requested.push(item)
        return new Promise((resolve) => {
          resolveEdits = resolve
        })
      },
    })

    accept(view, result, 'useTheme')
    assert.equal(view.state.doc.toString(), 'const a = 1\nuseTheme')
    assert.deepEqual(requested, [{ name: 'useTheme', source: './theme' }])

    // 导入语句回来之前用户又打了字：导入仍按请求时的位置换算到现在。
    const head = view.state.selection.main.head
    view.dispatch({ changes: { from: head, insert: '()' }, selection: { anchor: head + 2 } })
    resolveEdits({
      additionalTextEdits: [{ path: 'src/main.ts', range: range(1, 1, 1, 1), newText: "import { useTheme } from './theme'\n" }],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(view.state.doc.toString(), "import { useTheme } from './theme'\nconst a = 1\nuseTheme()")
  })

  void test('a superseded request shows nothing; a failed one falls back to local suggestions', async () => {
    const state = stateWithCursor('val§')
    const localResult: CompletionResult = { from: 0, options: [{ label: 'value' }] }
    const request = (error: AppError) => requestWorkbenchLanguageServiceCompletions({
      state,
      position: 3,
      path: 'src/main.ts',
      localResult,
      request: async () => Result.fail(error),
      resolve: async () => Result.fail(error),
    })
    assert.equal(await request(new AppError('CANCELLED', 'superseded')), null)
    assert.equal(await request(new AppError('TIMEOUT', 'slow')), localResult)
  })

  void test('merges local suggestions that share the same start without duplicates', () => {
    const state = stateWithCursor('const valueOne = 1\nval§')
    const result = buildWorkbenchLanguageServiceCompletionResult({
      state,
      position: state.selection.main.head,
      path: 'src/main.ts',
      result: { items: [{ label: 'valueOne', kind: 'variable' }] },
      localResult: {
        from: state.selection.main.head - 3,
        options: [{ label: 'valueOne' }, { label: 'valueTwo', boost: -2 }],
      },
    })
    assert.deepEqual(result?.options.map((option) => option.label), ['valueOne', 'valueTwo'])
  })
})
