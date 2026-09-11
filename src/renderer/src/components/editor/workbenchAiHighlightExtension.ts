import type { EditorState, Extension, Range, Transaction } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

import { isEmpty } from '@velaros-ai/core'

import { mapWorkbenchLineAnchor, resolveWorkbenchAnchorEndLine } from './workbenchLineAnchors'

/**
 * AI 选区的编辑器装饰：AI 指给用户看的几段代码按行标成淡紫色（见 `workbenchAiHighlightStore`）。
 *
 * 位置随编辑实时映射（规则见 `mapWorkbenchLineAnchor`）：代码被整段删掉时选区跟着消失，改动时回写
 * 新行号。切文件 / 外部整篇替换不算删除——清空后由上层按存储行号重新锚定（与讲解气泡、行内评论
 * 同一套约定）。
 */

export interface WorkbenchAiHighlightAnchor {
  id: string
  /** 起始行行首。 */
  from: number
  /** 结束行行尾。 */
  to: number
}

/** 整体替换当前文档的选区锚点（打开文件、存储变化后按行号重锚）。 */
export const setWorkbenchAiHighlightAnchorsEffect = StateEffect.define<WorkbenchAiHighlightAnchor[]>()

export interface WorkbenchAiHighlightExtensionOptions {
  /** 选区标着的代码被整段删掉。 */
  onAnchorsRemoved: (ids: string[]) => void
  /** 起止行随编辑变化。 */
  onAnchorLinesChanged: (updates: Array<{ id: string; startLine: number; endLine: number }>) => void
  /** 切文件 / 外部改动同步那种整篇替换：锚点作废但不算删除。 */
  isExternalDocReplace: (tr: Transaction) => boolean
}

/** 一段选区最多给这么多行上色；再长只标前面这些，免得装饰集膨胀。 */
const MaxHighlightedLines = 2000

const aiHighlightLine = Decoration.line({ class: 'cm-wbAiHighlight' })

function buildAiHighlightDecorations(
  state: EditorState,
  anchors: readonly WorkbenchAiHighlightAnchor[]
): DecorationSet {
  const doc = state.doc
  const lineStarts = new Set<number>()
  for (const anchor of anchors) {
    if (anchor.to > doc.length || anchor.from > anchor.to) continue
    const firstLine = doc.lineAt(anchor.from).number
    const lastLine = Math.min(doc.lineAt(anchor.to).number, firstLine + MaxHighlightedLines - 1)
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1)
      lineStarts.add(doc.line(lineNumber).from)
  }
  // 重叠的几段落在同一行只上一层色。
  const ranges: Array<Range<Decoration>> = [...lineStarts]
    .sort((left, right) => left - right)
    .map((from) => aiHighlightLine.range(from))
  return Decoration.set(ranges, true)
}

interface WorkbenchAiHighlightFieldValue {
  anchors: WorkbenchAiHighlightAnchor[]
  deco: DecorationSet
}

function sameAnchors(
  left: readonly WorkbenchAiHighlightAnchor[],
  right: readonly WorkbenchAiHighlightAnchor[]
): boolean {
  return (
    left.length === right.length &&
    left.every((anchor, index) => {
      const other = right[index]
      return !!other && anchor.id === other.id && anchor.from === other.from && anchor.to === other.to
    })
  )
}

export function createWorkbenchAiHighlightExtension(
  options: WorkbenchAiHighlightExtensionOptions
): Extension {
  const highlightField = StateField.define<WorkbenchAiHighlightFieldValue>({
    create: () => ({ anchors: [], deco: Decoration.none }),
    update(value, tr) {
      let anchors = value.anchors
      if (tr.docChanged) {
        anchors = options.isExternalDocReplace(tr)
          ? []
          : anchors.flatMap((anchor) => mapWorkbenchLineAnchor(anchor, tr.changes, tr.newDoc) ?? [])
      }
      for (const effect of tr.effects) {
        if (!effect.is(setWorkbenchAiHighlightAnchorsEffect)) continue
        // 编辑器自己回写行号后，存储通知回来的重锚与眼下的锚点一致：不必重建装饰。
        const next = effect.value.filter((anchor) => anchor.to >= anchor.from)
        if (!sameAnchors(anchors, next)) anchors = next
      }
      if (anchors === value.anchors && !tr.docChanged) return value
      return { anchors, deco: buildAiHighlightDecorations(tr.state, anchors) }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
  })

  const syncWatcher = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    if (update.transactions.some((tr) => options.isExternalDocReplace(tr))) return
    const before = update.startState.field(highlightField, false)
    const after = update.state.field(highlightField, false)
    if (!before || !after) return

    const afterIds = new Set(after.anchors.map((anchor) => anchor.id))
    const removed = before.anchors.filter((anchor) => !afterIds.has(anchor.id)).map((anchor) => anchor.id)
    if (!isEmpty(removed)) options.onAnchorsRemoved(removed)
    const lineUpdates = after.anchors.map((anchor) => ({
      id: anchor.id,
      startLine: update.state.doc.lineAt(anchor.from).number,
      endLine: resolveWorkbenchAnchorEndLine(update.state.doc, anchor),
    }))
    if (!isEmpty(lineUpdates)) options.onAnchorLinesChanged(lineUpdates)
  })

  const highlightTheme = EditorView.theme({
    '.cm-wbAiHighlight': {
      backgroundColor: 'var(--workbench-editor-ai-highlight-bg, rgba(168, 85, 247, 0.13))',
      boxShadow: 'inset 3px 0 0 var(--workbench-editor-ai-highlight-accent, rgba(168, 85, 247, 0.55))',
    },
  })

  return [highlightField, syncWatcher, highlightTheme]
}

/** 按存储里的行号把选区换算成当前文档的锚点；越界的选区（文件已被改短）略过。 */
export function buildWorkbenchAiHighlightAnchors(
  doc: { lines: number; line: (n: number) => { from: number; to: number } },
  highlights: ReadonlyArray<{ id: string; startLine: number; endLine: number }>
): WorkbenchAiHighlightAnchor[] {
  const anchors: WorkbenchAiHighlightAnchor[] = []
  for (const highlight of highlights) {
    if (highlight.startLine < 1 || highlight.startLine > doc.lines) continue
    const endLine = Math.min(Math.max(highlight.startLine, highlight.endLine), doc.lines)
    anchors.push({
      id: highlight.id,
      from: doc.line(highlight.startLine).from,
      to: doc.line(endLine).to,
    })
  }
  return anchors
}
