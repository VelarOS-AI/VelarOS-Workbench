import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  Text,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

import { isPresent } from '@velaros-ai/velaros/core'

import {
  type WorkbenchLanguageServiceDocumentHighlight,
  type WorkbenchLanguageServicePosition,
} from '@shared/contracts/workbench'

import { languageServiceRangeToOffsets } from './workbenchCodeMirrorLanguageService'

/**
 * 支持语义服务时只高亮同一符号，服务不可用时才匹配可视区里的同词。
 * 背景色取自该标识符自身的语法着色，做成低透明度的浅色包裹，不刺眼。
 */

const TOKEN_OCCURRENCE_CLASS = 'cm-workbenchTokenOccurrence'
const TOKEN_OCCURRENCE_BG_VAR = '--workbench-token-occurrence-bg'
/** 标识符组成字符：Unicode 字母/数字加下划线与美元符。 */
const WORD_PART_PATTERN = /[\p{L}\p{N}_$]/u
/** 至少含一个字母或 _/$ 才算「单词」，纯数字/纯符号不高亮，避免噪音。 */
const WORD_HAS_LETTER_PATTERN = /[\p{L}_$]/u
const TOKEN_OCCURRENCE_BG_ALPHA = 0.16
const SemanticOccurrenceDelayMs = 150
const EditedSemanticOccurrenceDelayMs = 500

interface WorkbenchCaretToken {
  from: number
  to: number
  text: string
}

const TOKEN_OCCURRENCE_MARK = Decoration.mark({ class: TOKEN_OCCURRENCE_CLASS })
const semanticOccurrenceRefreshEffect = StateEffect.define<void>()

export interface WorkbenchTokenOccurrenceRuntime {
  request: (
    content: string,
    position: WorkbenchLanguageServicePosition
  ) => Promise<Nullable<readonly WorkbenchLanguageServiceDocumentHighlight[]>>
}

function isWordChar(char: LooseOptional<string>): boolean {
  return isPresent(char) && WORD_PART_PATTERN.test(char)
}

/** 取光标所在（且未选中文本时）的完整标识符；不在单词上则返回 null。 */
function resolveCaretToken(state: EditorState): Nullable<WorkbenchCaretToken> {
  const selection = state.selection.main
  if (!selection.empty) return null

  const line = state.doc.lineAt(selection.head)
  const text = line.text
  let start = selection.head - line.from
  let end = start

  while (start > 0 && isWordChar(text[start - 1])) start--
  while (end < text.length && isWordChar(text[end])) end++
  if (start === end) return null

  const word = text.slice(start, end)
  if (!WORD_HAS_LETTER_PATTERN.test(word)) return null

  return { from: line.from + start, to: line.from + end, text: word }
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在可视区内按整词匹配所有出现位置，构建装饰集合。 */
function buildTokenOccurrenceDecorations(
  view: EditorView,
  token: WorkbenchCaretToken
): DecorationSet {
  let pattern: RegExp
  try {
    pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_$])${escapeRegExpLiteral(token.text)}(?![\\p{L}\\p{N}_$])`,
      'gu'
    )
  } catch {
    return Decoration.none
  }

  const builder = new RangeSetBuilder<Decoration>()
  for (const range of view.visibleRanges) {
    const text = view.state.sliceDoc(range.from, range.to)
    pattern.lastIndex = 0
    let match: Nullable<RegExpExecArray>
    while ((match = pattern.exec(text))) {
      const from = range.from + match.index
      builder.add(from, from + match[0].length, TOKEN_OCCURRENCE_MARK)
      if (pattern.lastIndex === match.index) pattern.lastIndex++
    }
  }

  return builder.finish()
}

export function buildWorkbenchSemanticOccurrenceDecorations(
  content: string,
  highlights: readonly WorkbenchLanguageServiceDocumentHighlight[]
): DecorationSet {
  const doc = Text.of(content.split('\n'))
  const ranges = new Map<string, { from: number; to: number }>()
  for (const highlight of highlights) {
    const range = languageServiceRangeToOffsets(doc, highlight.range)
    if (!range || range.from >= range.to) continue
    ranges.set(`${range.from}:${range.to}`, range)
  }
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of [...ranges.values()].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )) {
    builder.add(range.from, range.to, TOKEN_OCCURRENCE_MARK)
  }
  return builder.finish()
}

/** 读取标识符所在 DOM 节点的前景色，转成低透明度背景色。 */
function resolveTokenBackground(view: EditorView, token: WorkbenchCaretToken): Nullable<string> {
  const dom = view.domAtPos(token.from)
  let node: Nullable<Node> = dom.node
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement
  if (!(node instanceof HTMLElement)) return null

  const color = getComputedStyle(node).color
  const match = color.match(/rgba?\(([^)]+)\)/)
  if (!match) return null

  const [red, green, blue] = match[1].split(',').map((part) => part.trim())
  if (!isPresent(red) || !isPresent(green) || !isPresent(blue)) return null

  return `rgba(${red}, ${green}, ${blue}, ${TOKEN_OCCURRENCE_BG_ALPHA})`
}

export function createWorkbenchTokenOccurrenceHighlightExtension(
  runtime: Nullable<WorkbenchTokenOccurrenceRuntime> = null
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      private token: Nullable<WorkbenchCaretToken> = null
      private semanticDecorations: Nullable<DecorationSet> = null
      private useTextMatches = !runtime
      private requestGeneration = 0
      private timer: Nullable<ReturnType<typeof setTimeout>> = null

      constructor(view: EditorView) {
        this.token = view.hasFocus ? resolveCaretToken(view.state) : null
        this.applyToken(view, this.token)
        this.scheduleSemantic(view, this.token)
      }

      public update(update: ViewUpdate): void {
        if (
          !update.selectionSet &&
          !update.docChanged &&
          !update.viewportChanged &&
          !update.focusChanged
        )
          return

        const token = update.view.hasFocus ? resolveCaretToken(update.state) : null
        const tokenChanged = token?.text !== this.token?.text || token?.from !== this.token?.from
        const semanticChanged = tokenChanged || update.docChanged || update.focusChanged
        if (!semanticChanged && !update.viewportChanged) return

        this.token = token
        if (semanticChanged) {
          this.semanticDecorations = null
          this.useTextMatches = !runtime
          this.scheduleSemantic(
            update.view,
            token,
            update.docChanged ? EditedSemanticOccurrenceDelayMs : SemanticOccurrenceDelayMs
          )
        }
        // 滚动只重绘可视区内的同词匹配，语义范围覆盖全文。
        if (this.semanticDecorations) this.decorations = this.semanticDecorations
        else this.applyToken(update.view, token, semanticChanged)
      }

      public destroy(): void {
        this.requestGeneration += 1
        if (this.timer !== null) clearTimeout(this.timer)
      }

      private scheduleSemantic(
        view: EditorView,
        token: Nullable<WorkbenchCaretToken>,
        delay = SemanticOccurrenceDelayMs
      ): void {
        const generation = ++this.requestGeneration
        if (this.timer !== null) clearTimeout(this.timer)
        this.timer = null
        if (!runtime || !token) return
        this.timer = setTimeout(() => {
          this.timer = null
          void this.loadSemantic(view, token, generation)
        }, delay)
      }

      private applyToken(
        view: EditorView,
        token: Nullable<WorkbenchCaretToken>,
        shouldMeasureBackground = true
      ): void {
        this.decorations =
          token && this.useTextMatches
            ? buildTokenOccurrenceDecorations(view, token)
            : Decoration.none

        if (!token) {
          view.dom.style.removeProperty(TOKEN_OCCURRENCE_BG_VAR)
          return
        }
        if (shouldMeasureBackground && this.useTextMatches) this.measureBackground(view, token)
      }

      private measureBackground(view: EditorView, token: WorkbenchCaretToken): void {
        const generation = this.requestGeneration
        view.requestMeasure({
          key: this,
          read: () => resolveTokenBackground(view, token),
          write: (background) => {
            const style = view.dom.style
            const color = background ?? ''
            if (
              generation === this.requestGeneration &&
              style.getPropertyValue(TOKEN_OCCURRENCE_BG_VAR) !== color
            )
              style.setProperty(TOKEN_OCCURRENCE_BG_VAR, color)
          },
        })
      }

      private async loadSemantic(
        view: EditorView,
        token: WorkbenchCaretToken,
        generation: number
      ): Promise<void> {
        if (!runtime) return
        const doc = view.state.doc
        const line = doc.lineAt(token.from)
        let highlights: Nullable<readonly WorkbenchLanguageServiceDocumentHighlight[]>
        try {
          highlights = await runtime.request(doc.toString(), {
            line: line.number,
            column: token.from - line.from + 1,
            offset: token.from,
          })
        } catch {
          highlights = null
        }
        if (
          generation !== this.requestGeneration ||
          view.state.doc !== doc ||
          this.token?.from !== token.from
        )
          return
        if (highlights) {
          this.semanticDecorations = buildWorkbenchSemanticOccurrenceDecorations(
            doc.toString(),
            highlights
          )
          this.decorations = this.semanticDecorations
        } else {
          this.useTextMatches = true
          this.applyToken(view, token, false)
        }
        view.dispatch({ effects: semanticOccurrenceRefreshEffect.of() })
        if (this.decorations.size) this.measureBackground(view, token)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
