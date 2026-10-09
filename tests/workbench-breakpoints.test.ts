import assert from 'node:assert/strict'

import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import {
  isWorkbenchDebuggableFilePath,
  readWorkbenchBreakpointLines,
  readWorkbenchBreakpoints,
  readWorkbenchExceptionPause,
  setWorkbenchBreakpointLines,
  setWorkbenchExceptionPause,
  subscribeWorkbenchBreakpoints,
  toggleWorkbenchBreakpoint,
  WORKBENCH_BREAKPOINTS_STORAGE_KEY,
} from '../src/renderer/src/models/debug/workbenchBreakpoints'
import {
  createWorkbenchBreakpointGutterExtension,
  readWorkbenchEditorBreakpointLines,
  setWorkbenchEditorBreakpointLines,
  toggleWorkbenchEditorBreakpoint,
} from '../src/renderer/src/models/editor/workbenchBreakpointGutter'
import { findWorkbenchDebugHoverExpression } from '../src/renderer/src/models/editor/workbenchDebugHover'
import type { StorageLike } from '../src/renderer/src/support/localStorageJsonStore'

function createStorage(initial: Record<string, string> = {}): StorageLike & {
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

const Root = '/projects/shop'

void describe('breakpoints of a project', () => {
  void test('only JavaScript and TypeScript files take breakpoints', () => {
    for (const path of ['src/a.js', 'src/a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx', 'A.TS'])
      assert.equal(isWorkbenchDebuggableFilePath(path), true, path)
    for (const path of ['a.py', 'a.json', 'a.d.ts.map', 'ts', 'notes.md', 'a.vel', '', null, undefined])
      assert.equal(isWorkbenchDebuggableFilePath(path), false, String(path))
  })

  void test('are toggled by file and line, kept sorted and stored per project', () => {
    const storage = createStorage()
    assert.deepEqual(readWorkbenchBreakpoints(Root, storage), [])

    toggleWorkbenchBreakpoint(Root, 'src/b.ts', 9, storage)
    toggleWorkbenchBreakpoint(Root, 'src/a.ts', 12, storage)
    toggleWorkbenchBreakpoint(Root, 'src\\a.ts', 3, storage)
    toggleWorkbenchBreakpoint(Root, './src/a.ts', 3, storage)
    toggleWorkbenchBreakpoint(Root, 'src/a.ts', 7, storage)
    assert.deepEqual(readWorkbenchBreakpoints(Root, storage), [
      { path: 'src/a.ts', line: 7 },
      { path: 'src/a.ts', line: 12 },
      { path: 'src/b.ts', line: 9 },
    ])
    assert.deepEqual(readWorkbenchBreakpointLines(Root, 'src/a.ts', storage), [7, 12])
    assert.deepEqual(readWorkbenchBreakpointLines(Root, 'src/missing.ts', storage), [])
    // 别的项目看不到。
    assert.deepEqual(readWorkbenchBreakpoints('/projects/other', storage), [])

    // 编辑让断点挪了行：编辑器把这个文件此刻的断点行整份交过来，别的文件不动。
    setWorkbenchBreakpointLines(Root, 'src/a.ts', [14, 9, 9], storage)
    assert.deepEqual(readWorkbenchBreakpoints(Root, storage), [
      { path: 'src/a.ts', line: 9 },
      { path: 'src/a.ts', line: 14 },
      { path: 'src/b.ts', line: 9 },
    ])
    // 重启之后还在：存的就是这份。
    assert.deepEqual(JSON.parse(storage.values.get(WORKBENCH_BREAKPOINTS_STORAGE_KEY)!), {
      [Root]: {
        breakpoints: [
          { path: 'src/a.ts', line: 9 },
          { path: 'src/a.ts', line: 14 },
          { path: 'src/b.ts', line: 9 },
        ],
        pauseOnUncaughtExceptions: true,
      },
    })

    // 摘光了、开关也是默认的：不留空壳。
    setWorkbenchBreakpointLines(Root, 'src/a.ts', [], storage)
    toggleWorkbenchBreakpoint(Root, 'src/b.ts', 9, storage)
    assert.equal(storage.values.get(WORKBENCH_BREAKPOINTS_STORAGE_KEY), '{}')
  })

  void test('remembers whether to stop on uncaught exceptions, on by default', () => {
    const storage = createStorage()
    assert.equal(readWorkbenchExceptionPause(Root, storage), true)
    setWorkbenchExceptionPause(Root, false, storage)
    assert.equal(readWorkbenchExceptionPause(Root, storage), false)
    assert.equal(readWorkbenchExceptionPause('/projects/other', storage), true)
    // 关掉了就得记着，哪怕一个断点都没有。
    assert.deepEqual(JSON.parse(storage.values.get(WORKBENCH_BREAKPOINTS_STORAGE_KEY)!), {
      [Root]: { breakpoints: [], pauseOnUncaughtExceptions: false },
    })
    setWorkbenchExceptionPause(Root, true, storage)
    assert.equal(storage.values.get(WORKBENCH_BREAKPOINTS_STORAGE_KEY), '{}')
  })

  void test('does not trust what is in storage', () => {
    const storage = createStorage({
      [WORKBENCH_BREAKPOINTS_STORAGE_KEY]: JSON.stringify({
        [Root]: {
          breakpoints: [
            { path: 'src/a.ts', line: 3 },
            { path: 'src/a.ts', line: 3 },
            { path: 'src/a.ts', line: 0 },
            { path: 'src/a.ts', line: 2.5 },
            { path: 'src/a.ts', line: '4' },
            { path: '/etc/passwd', line: 1 },
            { path: 'C:\\Windows\\a.js', line: 1 },
            { path: '../outside.js', line: 1 },
            { path: 'src/../../outside.js', line: 1 },
            { path: '', line: 1 },
            { line: 1 },
            'src/a.ts:3',
            null,
            { path: 'src\\b.ts', line: 1 },
          ],
          pauseOnUncaughtExceptions: 'no',
        },
        '/projects/broken': 'not an object',
        '/projects/list': { breakpoints: 'src/a.ts:3' },
      }),
    })
    assert.deepEqual(readWorkbenchBreakpoints(Root, storage), [
      { path: 'src/a.ts', line: 3 },
      { path: 'src/b.ts', line: 1 },
    ])
    // 开关认不出来的当默认（停）。
    assert.equal(readWorkbenchExceptionPause(Root, storage), true)
    assert.deepEqual(readWorkbenchBreakpoints('/projects/broken', storage), [])
    assert.deepEqual(readWorkbenchBreakpoints('/projects/list', storage), [])

    storage.values.set(WORKBENCH_BREAKPOINTS_STORAGE_KEY, '{ broken json')
    assert.deepEqual(readWorkbenchBreakpoints(Root, storage), [])
  })

  void test('keeps only the projects whose breakpoints changed most recently', () => {
    const storage = createStorage()
    for (let index = 0; index < 70; index += 1)
      toggleWorkbenchBreakpoint(`/projects/p${index}`, 'a.ts', 1, storage)
    // 最早的那个项目又动了一下：它变成最近的。
    toggleWorkbenchBreakpoint('/projects/p10', 'a.ts', 2, storage)

    const stored = Object.keys(JSON.parse(storage.values.get(WORKBENCH_BREAKPOINTS_STORAGE_KEY)!) as object)
    assert.equal(stored.length <= 65, true)
    assert.deepEqual(readWorkbenchBreakpoints('/projects/p0', storage), [])
    assert.deepEqual(readWorkbenchBreakpointLines('/projects/p10', 'a.ts', storage), [1, 2])
    assert.deepEqual(readWorkbenchBreakpointLines('/projects/p69', 'a.ts', storage), [1])
  })

  void test('tells subscribers when something changed, and only then', () => {
    const storage = createStorage()
    let notified = 0
    const unsubscribe = subscribeWorkbenchBreakpoints(() => {
      notified += 1
    })
    try {
      toggleWorkbenchBreakpoint(Root, 'a.ts', 1, storage)
      setWorkbenchBreakpointLines(Root, 'a.ts', [1], storage)
      setWorkbenchExceptionPause(Root, true, storage)
      assert.equal(notified, 1)
      setWorkbenchBreakpointLines(Root, 'a.ts', [2], storage)
      setWorkbenchExceptionPause(Root, false, storage)
      assert.equal(notified, 3)
    } finally {
      unsubscribe()
    }
    toggleWorkbenchBreakpoint(Root, 'a.ts', 9, storage)
    assert.equal(notified, 3)
  })
})

/** 一个带断点扩展的编辑器状态（不挂视图：只看断点跟着文档怎么走）。 */
function stateWithBreakpoints(doc: string, lines: readonly number[]): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      createWorkbenchBreakpointGutterExtension({
        readLines: () => lines,
        writeLines: () => undefined,
        subscribeLines: () => () => undefined,
        readVerified: () => null,
        subscribeVerified: () => () => undefined,
      }),
    ],
  })
}

const Lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n')

void describe('breakpoints in the editor', () => {
  void test('start from the stored lines and follow their line through edits', () => {
    let state = stateWithBreakpoints(Lines, [3, 7, 99])
    // 存着的行号超出了文件（文件在别处被改短了）：落在最后一行。
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [3, 7, 10])

    // 在上面插两行：断点跟着下去。
    state = state.update({ changes: { from: 0, insert: 'a\nb\n' } }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [5, 9, 12])
    // 在断点那一行里打字：行号不变。
    state = state.update({ changes: { from: state.doc.line(5).from + 2, insert: 'xyz' } }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [5, 9, 12])
    // 在断点那一行行首回车：断点留在原来那一行的内容上（它被推到了下一行）。
    state = state.update({ changes: { from: state.doc.line(5).from, insert: '\n' } }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [6, 10, 13])
    // 把两个断点之间的几行连同后一个断点所在的行并成一行：两个断点落到同一行上，并成一个。
    state = state.update({
      changes: { from: state.doc.line(6).to, to: state.doc.line(10).from, insert: ' ' },
    }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [6, 9])
    // 删掉断点所在的一整段（从上一行中间删到下一行中间）：断点没了。
    state = state.update({
      changes: { from: state.doc.line(5).from, to: state.doc.line(7).from + 1 },
    }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [7])
  })

  void test('are toggled on a line and replaced when the store changed elsewhere', () => {
    let state = stateWithBreakpoints(Lines, [])
    state = state.update({ effects: toggleWorkbenchEditorBreakpoint.of(4) }).state
    state = state.update({ effects: toggleWorkbenchEditorBreakpoint.of(2) }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [2, 4])
    state = state.update({ effects: toggleWorkbenchEditorBreakpoint.of(4) }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [2])
    // 行号越界的落在最后一行。
    state = state.update({ effects: toggleWorkbenchEditorBreakpoint.of(500) }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [2, 10])

    state = state.update({ effects: setWorkbenchEditorBreakpointLines.of([8, 1, 8]) }).state
    assert.deepEqual(readWorkbenchEditorBreakpointLines(state), [1, 8])
    // 没挂断点扩展的文件（不是 JS / TS）：没有断点。
    assert.deepEqual(readWorkbenchEditorBreakpointLines(EditorState.create({ doc: Lines })), [])
  })
})

void describe('hovering a name while the program is paused', () => {
  const source = [
    'const config = { retries: 3, nested: { label: "x" } }', // 1
    'function run(input) {', // 2
    '  const total = input.items.length + config.retries', // 3
    '  this.cache = lookup(total).value', // 4
    '  return user?.profile.name + list[index].title', // 5
    '}', // 6
    '',
  ].join('\n')
  const state = EditorState.create({ doc: source, extensions: [javascript({ typescript: true })] })
  assert.ok(ensureSyntaxTree(state, source.length, 5_000))

  /** 鼠标停在 `text` 的第 `offset` 个字符上时要求值的表达式。 */
  const expressionAt = (text: string, offset = 1): Nullable<string> => {
    const index = source.indexOf(text)
    assert.ok(index >= 0, text)
    return findWorkbenchDebugHoverExpression(state, index + offset)?.expression ?? null
  }

  void test('reads beyond the initial viewport after background parsing advances', () => {
    const source = `${'const item = 1\n'.repeat(500)}const lastValue = item\n`
    const state = EditorState.create({ doc: source, extensions: [javascript()] })
    const position = source.lastIndexOf('lastValue') + 1
    // 推进后台解析上下文，保留原状态，验证悬浮读取补齐后的树；不依赖 CI 在 50ms 内解析完成。
    assert.ok(ensureSyntaxTree(state, source.length, 5_000))
    assert.equal(findWorkbenchDebugHoverExpression(state, position)?.expression, 'lastValue')
  })

  void test('evaluates variables, parameters, this and plain property chains', () => {
    assert.equal(expressionAt('config ='), 'config')
    assert.equal(expressionAt('input)'), 'input')
    assert.equal(expressionAt('total ='), 'total')
    assert.equal(expressionAt('input.items'), 'input')
    // 停在属性链中间：求到这一段为止。
    assert.equal(expressionAt('items.length'), 'input.items')
    assert.equal(expressionAt('length +'), 'input.items.length')
    assert.equal(expressionAt('retries\n'), 'config.retries')
    assert.equal(expressionAt('this.cache'), 'this')
    assert.equal(expressionAt('cache ='), 'this.cache')
    assert.equal(expressionAt('profile.name'), 'user?.profile')
    assert.equal(expressionAt('name +'), 'user?.profile.name')
    // 标识符的末尾也算在它上面。
    assert.equal(expressionAt('total =', 5), 'total')
    // 要显示的范围就是鼠标所在的那个名字。
    const found = findWorkbenchDebugHoverExpression(state, source.indexOf('length +') + 1)
    assert.equal(state.sliceDoc(found!.from, found!.to), 'length')
  })

  void test('does not evaluate anything that could run code or is not a value', () => {
    // 调用结果上的属性、下标访问后面的属性：求它们要先调函数、先算下标。
    assert.equal(expressionAt('value\n'), null)
    assert.equal(expressionAt('title'), null)
    // 对象字面量里的属性名、关键字、字符串、数字、运算符。
    assert.equal(expressionAt('retries: 3'), null)
    assert.equal(expressionAt('label: "x"'), null)
    assert.equal(expressionAt('const config'), null)
    assert.equal(expressionAt('function run'), null)
    assert.equal(expressionAt('"x"'), null)
    assert.equal(expressionAt('3,'), null)
    assert.equal(expressionAt('return'), null)
    // 函数名、下标里的变量本身是变量：可以看。
    assert.equal(expressionAt('lookup('), 'lookup')
    assert.equal(expressionAt('index]'), 'index')
    assert.equal(expressionAt('list['), 'list')
  })
})
