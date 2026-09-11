import assert from 'node:assert/strict'

import { Annotation, EditorState, Text, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, test } from 'bun:test'

import {
  buildWorkbenchAiHighlightAnchors,
  createWorkbenchAiHighlightExtension,
  setWorkbenchAiHighlightAnchorsEffect,
} from '../src/renderer/src/components/editor/workbenchAiHighlightExtension'
import {
  resolveReleasedAiHighlightTabs,
  WorkbenchAiHighlightStore,
} from '../src/renderer/src/models/aiHighlights/workbenchAiHighlightStore'
import { buildWorkbenchMinimalTextChanges } from '../src/renderer/src/models/editor/workbenchMinimalTextChanges'

/**
 * 不挂 DOM 的编辑器：只有状态与扩展，手动把 update listener 喂一遍；存储一变就按行号重锚（与编辑器
 * 组件订阅存储的做法一致）。
 */
function createEditorHarness(doc: string, highlights: Array<{ startLine: number; endLine: number }>) {
  const store = new WorkbenchAiHighlightStore()
  store.add('/repo', highlights.map((range) => ({ path: 'a.ts', ...range })))
  const external = Annotation.define<boolean>()
  const removed: string[] = []
  let state = EditorState.create({
    doc,
    extensions: [
      createWorkbenchAiHighlightExtension({
        onAnchorsRemoved: (ids) => {
          removed.push(...ids)
          store.removeMany(ids)
        },
        onAnchorLinesChanged: store.updateLines,
        isExternalDocReplace: (tr) => tr.annotation(external) === true,
      }),
    ],
  })
  const reanchor = (): void => {
    state = state.update({
      effects: setWorkbenchAiHighlightAnchorsEffect.of(
        buildWorkbenchAiHighlightAnchors(state.doc, store.listForPath('/repo', 'a.ts'))
      ),
    }).state
  }
  reanchor()
  const dispatch = (spec: TransactionSpec): void => {
    const tr = state.update(spec)
    const startState = state
    state = tr.state
    const update = { docChanged: tr.docChanged, transactions: [tr], startState, state }
    for (const listener of state.facet(EditorView.updateListener)) listener(update as never)
    reanchor()
  }
  return {
    get state() {
      return state
    },
    dispatch,
    replaceExternally: (content: string) =>
      dispatch({ changes: { from: 0, to: state.doc.length, insert: content }, annotations: external.of(true) }),
    removed,
    /** 存储里的选区行号。 */
    ranges: () => store.listForPath('/repo', 'a.ts').map(({ startLine, endLine }) => [startLine, endLine]),
    /** 编辑器里真正上了色的行。 */
    litLines: () => {
      const lines: number[] = []
      for (const source of state.facet(EditorView.decorations)) {
        if (typeof source === 'function') continue
        source.between(0, state.doc.length, (from) => {
          lines.push(state.doc.lineAt(from).number)
        })
      }
      return lines
    },
  }
}

void describe('Workbench AI selections', () => {
  void test('are kept per project and file, without duplicating an identical range', () => {
    const store = new WorkbenchAiHighlightStore()
    const added = store.add('/repo/', [
      { path: 'src/a.ts', startLine: 3, endLine: 5 },
      { path: 'src/a.ts', startLine: 3, endLine: 5 },
      { path: 'src/b.ts', startLine: 9, endLine: 2 },
    ])
    assert.equal(added.length, 2)
    // 结束行早于起始行时收成一行。
    assert.deepEqual(
      store.listForPath('/repo', 'src/b.ts').map(({ startLine, endLine }) => [startLine, endLine]),
      [[9, 9]]
    )
    assert.equal(store.add('/repo', [{ path: 'src/a.ts', startLine: 3, endLine: 5 }]).length, 0)
    store.add('/other', [{ path: 'src/a.ts', startLine: 1, endLine: 1 }])
    assert.deepEqual(
      store.listForProject('/repo').map(({ path, startLine }) => `${path}:${startLine}`),
      ['src/a.ts:3', 'src/b.ts:9']
    )
  })

  void test('are cancelled in batches by the AI and follow edits', () => {
    const store = new WorkbenchAiHighlightStore()
    const [first] = store.add('/repo', [
      { path: 'src/a.ts', startLine: 3, endLine: 5 },
      { path: 'src/b.ts', startLine: 1, endLine: 2 },
      { path: 'src/c.ts', startLine: 7, endLine: 7 },
    ])
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })

    store.updateLines([{ id: first.id, startLine: 4, endLine: 6 }])
    assert.deepEqual(
      store.listForPath('/repo', 'src/a.ts').map(({ startLine, endLine }) => [startLine, endLine]),
      [[4, 6]]
    )
    // 行号没变不通知。
    store.updateLines([{ id: first.id, startLine: 4, endLine: 6 }])
    assert.equal(notified, 1)

    assert.equal(store.clear('/repo', ['src/a.ts', 'src/b.ts']), 2)
    assert.deepEqual(store.listForProject('/repo').map(({ path }) => path), ['src/c.ts'])
    assert.equal(store.clear('/repo'), 1)
    assert.deepEqual(store.listForProject('/repo'), [])
  })

  void test('follow a renamed or moved file instead of being released', () => {
    const store = new WorkbenchAiHighlightStore()
    store.add('/repo', [
      { path: 'src/a.ts', startLine: 1, endLine: 2 },
      { path: 'src/lib/b.ts', startLine: 3, endLine: 3 },
      { path: 'src/library.ts', startLine: 4, endLine: 4 },
    ])
    store.add('/other', [{ path: 'src/a.ts', startLine: 1, endLine: 1 }])

    store.renamePath('/repo', 'src/a.ts', 'src/renamed.ts')
    // 目录改名带上它下面的文件，但不误伤同前缀的兄弟文件。
    store.renamePath('/repo/', 'src/lib', 'pkg/lib')
    assert.deepEqual(
      store.listForProject('/repo').map(({ path }) => path),
      ['pkg/lib/b.ts', 'src/library.ts', 'src/renamed.ts']
    )
    assert.deepEqual(store.listForProject('/other').map(({ path }) => path), ['src/a.ts'])
  })

  void test('are released only when their tab closes or the project changes', () => {
    const tabs = (root: string, ...paths: string[]) => ({ root, paths: new Set(paths) })
    // AI 刚标上、标签还没开出来：什么都不释放。
    assert.equal(resolveReleasedAiHighlightTabs(tabs('/repo'), tabs('/repo', 'a.ts')), null)
    assert.equal(resolveReleasedAiHighlightTabs(tabs('/repo', 'a.ts'), tabs('/repo', 'a.ts', 'b.ts')), null)
    // 关掉一个或几个标签：只释放这些文件。
    assert.deepEqual(resolveReleasedAiHighlightTabs(tabs('/repo', 'a.ts', 'b.ts', 'c.ts'), tabs('/repo', 'b.ts')), {
      root: '/repo',
      paths: ['a.ts', 'c.ts'],
    })
    // 换项目、关项目：上一个项目整个释放。
    assert.deepEqual(resolveReleasedAiHighlightTabs(tabs('/repo', 'a.ts'), tabs('/next')), {
      root: '/repo',
      paths: null,
    })
    assert.deepEqual(resolveReleasedAiHighlightTabs(tabs('/repo', 'a.ts'), tabs('')), { root: '/repo', paths: null })
    // 首次挂载（还没有项目）不误清。
    assert.equal(resolveReleasedAiHighlightTabs(tabs(''), tabs('/repo', 'a.ts')), null)
  })

  void test('anchor to whole lines of the current document and skip ranges past its end', () => {
    const doc = Text.of(['one', 'two', 'three', 'four'])
    const anchors = buildWorkbenchAiHighlightAnchors(doc, [
      { id: 'a', startLine: 2, endLine: 3 },
      { id: 'b', startLine: 4, endLine: 99 },
      { id: 'c', startLine: 7, endLine: 8 },
    ])
    assert.deepEqual(anchors, [
      { id: 'a', from: doc.line(2).from, to: doc.line(3).to },
      { id: 'b', from: doc.line(4).from, to: doc.line(4).to },
    ])
  })
})

void describe('Workbench AI selections in the editor', () => {
  void test('keep trailing empty lines while the user types elsewhere', () => {
    const editor = createEditorHarness('a\nb\n\n\n\nz', [{ startLine: 2, endLine: 5 }])
    for (let index = 0; index < 3; index += 1) editor.dispatch({ changes: { from: 0, insert: 'x' } })
    assert.deepEqual(editor.ranges(), [[2, 5]])
    assert.deepEqual(editor.litLines(), [2, 3, 4, 5])
  })

  void test('move with the code and stay whole when lines are inserted above', () => {
    const editor = createEditorHarness('a\nb\nc\nd\n', [{ startLine: 2, endLine: 3 }])
    editor.dispatch({ changes: { from: 0, insert: 'new\n' } })
    assert.deepEqual(editor.ranges(), [[3, 4]])
    // 在选区第一行行首回车：代码往下挪，选区跟着代码走。
    editor.dispatch({ changes: { from: editor.state.doc.line(3).from, insert: '\n' } })
    assert.deepEqual(editor.ranges(), [[4, 5]])
    assert.deepEqual(editor.litLines(), [4, 5])
  })

  void test('disappear when the code they mark is deleted, including an empty marked line', () => {
    const block = createEditorHarness('a\nb\nc\nd\ne', [{ startLine: 2, endLine: 3 }])
    block.dispatch({ changes: { from: block.state.doc.line(2).from, to: block.state.doc.line(4).from } })
    assert.deepEqual(block.ranges(), [])
    assert.equal(block.removed.length, 1)

    // 空行被删掉：选区跟着消失，而不是跳到相邻的那一行。
    const emptyLine = createEditorHarness('a\nb\n\nd\ne', [{ startLine: 3, endLine: 3 }])
    emptyLine.dispatch({
      changes: { from: emptyLine.state.doc.line(3).from, to: emptyLine.state.doc.line(4).from },
    })
    assert.deepEqual(emptyLine.ranges(), [])

    const backspaced = createEditorHarness('a\nb\n\nd', [{ startLine: 3, endLine: 3 }])
    const emptyFrom = backspaced.state.doc.line(3).from
    backspaced.dispatch({ changes: { from: emptyFrom - 1, to: emptyFrom } })
    assert.deepEqual(backspaced.ranges(), [])

    // 在标着的空行里打字：这一行还在，选区留着并覆盖新写的内容。
    const typed = createEditorHarness('a\n\nc', [{ startLine: 2, endLine: 2 }])
    typed.dispatch({ changes: { from: typed.state.doc.line(2).from, insert: 'hello' } })
    typed.dispatch({ changes: { from: typed.state.doc.line(2).from, to: typed.state.doc.line(2).from + 1 } })
    assert.deepEqual(typed.ranges(), [[2, 2]])
    assert.deepEqual(typed.litLines(), [2])
  })

  void test('survive formatting applied as minimal changes', () => {
    const before = 'function a() {\nconst x = 1\nreturn x\n}\n\nfunction b() {}\n'
    const after = 'function a() {\n  const x = 1\n  return x\n}\n\nfunction b() {}\n'
    const editor = createEditorHarness(before, [
      { startLine: 2, endLine: 3 },
      { startLine: 5, endLine: 5 },
    ])
    editor.dispatch({ changes: buildWorkbenchMinimalTextChanges(before, after) })
    assert.equal(editor.state.doc.toString(), after)
    assert.deepEqual(editor.ranges(), [
      [2, 3],
      [5, 5],
    ])
    assert.equal(editor.removed.length, 0)
  })

  void test('are re-anchored by line after an external whole-file replacement, not deleted', () => {
    const editor = createEditorHarness('a\nb\nc\n', [{ startLine: 2, endLine: 2 }])
    editor.replaceExternally('A\nB\nC\nD\n')
    assert.deepEqual(editor.ranges(), [[2, 2]])
    assert.deepEqual(editor.litLines(), [2])
    assert.equal(editor.removed.length, 0)
  })
})
