import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorState } from '@codemirror/state'
import type { Decoration } from '@codemirror/view'
import { describe, test } from 'bun:test'

import { computeWorkbenchDiffInlineChanges } from '../src/renderer/src/models/git/workbenchDiffInlineChanges'
import {
  buildWorkbenchDiffPaneLayout,
  getWorkbenchDiffPaneText,
  pairWorkbenchDiffRows,
  type WorkbenchDiffPane,
} from '../src/renderer/src/models/git/workbenchDiffSideBySide'
import type { WorkbenchUnifiedDiffRow } from '../src/renderer/src/models/git/workbenchGitDiffModel'
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  normalizeWorkbenchPreferences,
} from '../src/renderer/src/models/workbenchPreferences'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n/WorkbenchLocalizationProvider')
const { buildReadOnlyDiffDecorations } = await import(
  '../src/renderer/src/components/editor/ReadOnlyDiffCodeMirror'
)
const { WorkbenchUnifiedDiffRows } = await import(
  '../src/renderer/src/components/git/WorkbenchUnifiedDiffRows'
)

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

/**
 * `-旧行` / `+新行` / ` 没变的行` / `@@` 分隔行 → 差异行。`hunks` 给每一行所属的块（与行一一对应，
 * 不属于任何块的给 null）。
 */
function rows(lines: string[], hunks: Array<Nullable<number>> = []): WorkbenchUnifiedDiffRow[] {
  let oldLine = 1
  let newLine = 1
  return lines.map((line, index) => {
    const kind = line.startsWith('-')
      ? 'deletion'
      : line.startsWith('+')
        ? 'addition'
        : line.startsWith('@@')
          ? 'hunk'
          : 'context'
    const row: WorkbenchUnifiedDiffRow = {
      id: String(index),
      kind,
      oldLine: kind === 'deletion' || kind === 'context' ? oldLine : null,
      newLine: kind === 'addition' || kind === 'context' ? newLine : null,
      marker: '',
      text: kind === 'hunk' ? line : line.slice(1),
    }
    if (row.oldLine !== null) oldLine += 1
    if (row.newLine !== null) newLine += 1
    const hunk = hunks[index]
    if (hunk !== null && hunk !== undefined) row.hunk = hunk
    return row
  })
}

const sample = rows(
  [
    ' import a',
    '-const one = 1',
    '-const two = 2',
    '+const one = 10',
    ' middle',
    '+added only',
    ' tail',
    '@@ -20,2 +21,1 @@',
    '-removed only',
    ' end',
  ],
  [null, 0, 0, 0, null, 1, null, null, 2, null]
)

/** 一栏里的装饰，按位置排好：`行号:类名` 或 `行号:类名[文字]`（行内的标记）或 `行号:按钮/空位`。 */
function describeDecorations(
  diffRows: WorkbenchUnifiedDiffRow[],
  pane: WorkbenchDiffPane,
  hunkLines: ReadonlyMap<number, number>,
  withActions: boolean
): string[] {
  const state = EditorState.create({ doc: getWorkbenchDiffPaneText(diffRows, pane) })
  const decorations = buildReadOnlyDiffDecorations(
    state,
    diffRows,
    pane,
    computeWorkbenchDiffInlineChanges(diffRows),
    hunkLines,
    withActions
      ? { actions: [{ id: 'stage', label: 'Stage' }], disabled: false, onAction: () => undefined }
      : null,
    () => null
  )
  const described: string[] = []
  const cursor = decorations.iter()
  while (cursor.value) {
    const spec = (cursor.value as Decoration).spec as {
      class?: string
      attributes?: { class?: string }
      widget?: { placeholder?: boolean }
    }
    const line = state.doc.lineAt(cursor.from).number
    if (spec.widget) described.push(`${line}:${spec.widget.placeholder ? 'space' : 'buttons'}`)
    else if (spec.attributes?.class) described.push(`${line}:${spec.attributes.class}`)
    else described.push(`${line}:${spec.class}[${state.sliceDoc(cursor.from, cursor.to)}]`)
    cursor.next()
  }
  return described
}

void describe('Workbench side-by-side diff rows', () => {
  void test('deletions go left, additions right, and the longer side faces filler lines', () => {
    assert.deepEqual(pairWorkbenchDiffRows(sample), [
      { left: 0, right: 0 },
      { left: 1, right: 3 },
      { left: 2, right: null },
      { left: 4, right: 4 },
      { left: null, right: 5 },
      { left: 6, right: 6 },
      { left: 7, right: 7 },
      { left: 8, right: null },
      { left: 9, right: 9 },
    ])
    assert.deepEqual(pairWorkbenchDiffRows([]), [])
    // 新增行多于删除行。
    assert.deepEqual(pairWorkbenchDiffRows(rows(['-a', '+b', '+c'])), [
      { left: 0, right: 1 },
      { left: null, right: 2 },
    ])
  })

  void test('both panes have the same number of lines, with empty lines as fillers', () => {
    const layout = buildWorkbenchDiffPaneLayout(sample, 'split')
    assert.deepEqual(
      layout.panes.map((pane) => [pane.side, pane.hunkBar]),
      [
        ['old', 'placeholder'],
        ['new', 'buttons'],
      ]
    )
    const [left, right] = layout.panes.map((pane) => getWorkbenchDiffPaneText(sample, pane).split('\n'))
    assert.deepEqual(left, [
      'import a',
      'const one = 1',
      'const two = 2',
      'middle',
      '',
      'tail',
      '@@ -20,2 +21,1 @@',
      'removed only',
      'end',
    ])
    assert.deepEqual(right, [
      'import a',
      'const one = 10',
      '',
      'middle',
      'added only',
      'tail',
      '@@ -20,2 +21,1 @@',
      '',
      'end',
    ])
    // 每处改动从哪一行开始（上一处、下一处按它跳）；每块的按钮放在哪一行上方，两栏同一行。
    assert.deepEqual(layout.anchors, [2, 5, 8])
    assert.deepEqual([...layout.hunkLines], [
      [1, 0],
      [4, 1],
      [7, 2],
    ])
  })

  void test('the unified layout is one pane with every row in order', () => {
    const layout = buildWorkbenchDiffPaneLayout(sample, 'unified')
    assert.equal(layout.panes.length, 1)
    assert.equal(layout.panes[0].side, 'unified')
    assert.deepEqual(layout.panes[0].rowIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.deepEqual(layout.anchors, [2, 6, 9])
    assert.deepEqual([...layout.hunkLines], [
      [1, 0],
      [5, 1],
      [8, 2],
    ])
  })
})

void describe('Workbench diff decorations', () => {
  void test('one column: changed lines are tinted and the changed words marked', () => {
    const layout = buildWorkbenchDiffPaneLayout(sample, 'unified')
    assert.deepEqual(describeDecorations(sample, layout.panes[0], layout.hunkLines, true), [
      '2:buttons',
      '2:cm-diffLineDel',
      '2:cm-diffWordDel[1]',
      '3:cm-diffLineDel',
      '4:cm-diffLineAdd',
      '4:cm-diffWordAdd[10]',
      '6:buttons',
      '6:cm-diffLineAdd',
      '9:buttons',
      '9:cm-diffLineDel',
    ])
  })

  void test('side by side: each pane shows its own side, fillers and the same bar positions', () => {
    const layout = buildWorkbenchDiffPaneLayout(sample, 'split')
    const [left, right] = layout.panes
    assert.deepEqual(describeDecorations(sample, left, layout.hunkLines, true), [
      '2:space',
      '2:cm-diffLineDel',
      '2:cm-diffWordDel[1]',
      '3:cm-diffLineDel',
      '5:space',
      '5:cm-diffLineFiller',
      '8:space',
      '8:cm-diffLineDel',
    ])
    assert.deepEqual(describeDecorations(sample, right, layout.hunkLines, true), [
      '2:buttons',
      '2:cm-diffLineAdd',
      '2:cm-diffWordAdd[10]',
      '3:cm-diffLineFiller',
      '5:buttons',
      '5:cm-diffLineAdd',
      '8:buttons',
      '8:cm-diffLineFiller',
    ])
    // 没有按块操作的差异（本地历史、AI 改动）不放按钮，也不留空位。
    assert.deepEqual(
      describeDecorations(sample, left, layout.hunkLines, false).filter((entry) =>
        /space|buttons/u.test(entry)
      ),
      []
    )
  })
})

void describe('Workbench diff layout preference', () => {
  void test('the layout is remembered, and anything unknown falls back to one column', () => {
    assert.equal(DEFAULT_WORKBENCH_PREFERENCES.diffLayout, 'unified')
    assert.equal(normalizeWorkbenchPreferences({ diffLayout: 'split' }).diffLayout, 'split')
    assert.equal(normalizeWorkbenchPreferences({}).diffLayout, 'unified')
    assert.equal(
      normalizeWorkbenchPreferences({ diffLayout: 'side-by-side' as never }).diffLayout,
      'unified'
    )
  })

  void test('the switch is in every diff toolbar and writes the preference', () => {
    const toggle = readSource('src/renderer/src/components/git/WorkbenchDiffLayoutToggle.tsx')
    assert.match(toggle, /const split = useWorkbenchDiffLayout\(\) === 'split'/u)
    assert.match(toggle, /onClick=\{\(\) => saveWorkbenchDiffLayout\(split \? 'unified' : 'split'\)\}/u)
    assert.match(toggle, /aria-pressed=\{split\}/u)
    for (const consumer of [
      'src/renderer/src/components/git/GitDiffEditorPanel.tsx',
      'src/renderer/src/components/editor/FileHistoryView.tsx',
      'src/renderer/src/components/aiChanges/WorkbenchAiChangeDiffPanel.tsx',
    ])
      assert.match(readSource(consumer), /<WorkbenchDiffLayoutToggle \/>/u, consumer)
  })
})

void describe('Workbench diff viewer loading', () => {
  void test('the viewer body is loaded on demand, not with the workspace shell', () => {
    const wrapper = readSource('src/renderer/src/components/git/WorkbenchUnifiedDiffRows.tsx')
    // 只从查看器本体的模块拿类型；值走按需加载的入口。
    assert.match(
      wrapper,
      /lazyWithPreload<[\s\S]*?>\(async \(\) => \(await import\('\.\.\/editor\/ReadOnlyDiffCodeMirror'\)\)\.ReadOnlyDiffCodeMirror\)/u
    )
    assert.match(wrapper, /import type \{[^}]*\} from '\.\.\/editor\/ReadOnlyDiffCodeMirror'/u)
    assert.doesNotMatch(wrapper, /import \{[^}]*\} from '\.\.\/editor\/ReadOnlyDiffCodeMirror'/u)
    assert.match(wrapper, /const layout = useWorkbenchDiffLayout\(\)/u)
    assert.match(wrapper, /layout=\{layout\}/u)
    // 别处也不能把本体静态引进来（否则它又回到外壳包里）。
    for (const consumer of [
      'src/renderer/src/components/git/GitDiffEditorPanel.tsx',
      'src/renderer/src/components/editor/FileHistoryView.tsx',
      'src/renderer/src/components/aiChanges/WorkbenchAiChangeDiffPanel.tsx',
      'src/renderer/src/components/editor/EditorPanel.tsx',
    ])
      assert.doesNotMatch(
        readSource(consumer),
        /import \{[^}]*\} from '[^']*ReadOnlyDiffCodeMirror'/u,
        consumer
      )
  })

  void test('a jump asked for before the viewer is ready is carried out once it is', () => {
    const wrapper = readSource('src/renderer/src/components/git/WorkbenchUnifiedDiffRows.tsx')
    const viewer = readSource('src/renderer/src/components/editor/ReadOnlyDiffCodeMirror.tsx')
    assert.match(
      wrapper,
      /if \(viewerRef\.current\) viewerRef\.current\.goToChange\(direction\)\s*else pendingDirectionRef\.current = direction/u
    )
    assert.match(wrapper, /pendingDirectionRef\.current = null\s*viewer\.goToChange\(pending\)/u)
    assert.match(viewer, /if \(!view\) \{\s*pendingDirectionRef\.current = direction\s*return/u)
    assert.match(viewer, /if \(pendingDirection !== null\) goToChange\(pendingDirection\)/u)
  })

  void test('while the body loads the viewer keeps its place in the page', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkbenchLocalizationProvider, {
        value: { locale: 'en-US', setLocale: async () => undefined, t: (key) => key },
        children: createElement(WorkbenchUnifiedDiffRows, {
          rows: sample,
          path: 'src/a.ts',
          workbenchTheme: 'light-modern',
          ariaLabel: 'diff',
        }),
      })
    )
    // 外层的容器先在（占着位置），本体加载好之前里面是空的。
    assert.equal(markup, '<div aria-label="diff"></div>')
  })

  void test('two panes scroll together and the view stays on the row it showed', () => {
    const viewer = readSource('src/renderer/src/components/editor/ReadOnlyDiffCodeMirror.tsx')
    assert.match(viewer, /views\.length > 1 \? linkDiffPaneScroll\(views\[0\], primary\) : null/u)
    assert.match(viewer, /target\.scrollTop = source\.scrollTop\s*target\.scrollLeft = source\.scrollLeft/u)
    // 换排法、重读差异之后按「看的是哪一行」回到原处，不是按像素。
    assert.match(viewer, /scrollRef\.current = readDiffScrollPosition\(primary, panes, path\)/u)
    assert.match(viewer, /restoreDiffScrollPosition\(primary, panes, saved\)/u)
    // 上下排时第二栏藏着，宿主元素一直都在。
    assert.match(viewer, /data-layout=\{layout\}/u)
    const styles = readSource('src/renderer/src/styles/10-history.module.css')
    assert.match(
      styles,
      /\.workbenchDiffPanes\[data-layout='unified'\] > \[data-pane='secondary'\] \{\s*display: none;/u
    )
    assert.match(styles, /:global\(\.cm-diffWordAdd\)/u)
    assert.match(styles, /:global\(\.cm-diffWordDel\)/u)
    assert.match(styles, /:global\(\.cm-diffLineFiller\)/u)
  })
})
