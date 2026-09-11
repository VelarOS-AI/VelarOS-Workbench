import type { EditorState, Extension, Range, Transaction } from '@codemirror/state'
import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

import { isEmpty } from '@velaros-ai/core'

import { mapWorkbenchLineAnchor, resolveWorkbenchAnchorEndLine } from './workbenchLineAnchors'

/**
 * AI 讲解气泡的编辑器装饰（`workbench:explain_code`）。
 *
 * - 每条讲解在行号旁留一个序号标记，点它显示 / 隐藏这一条的气泡；当前讲解的那几行打一层浅底色，
 *   在最后一行下面展开成气泡：顶部一行「‹ 序号 › 标题 ×」，下面是正文。其余讲解只留标记，不着色。
 *   标记放在行号栏里而不是行尾：编辑区窄、代码行长时，行尾早就滚出视野了。
 * - 位置随编辑实时映射（规则见 `mapWorkbenchLineAnchor`）：代码被整段删掉时讲解跟着消失，改动时
 *   回写新行号。切文件 / 外部整篇替换不算删除——清空后由上层按存储行号重新锚定（与行内评论同一套约定）。
 */

export interface WorkbenchExplanationAnchor {
  id: string
  /** 起始行行首。 */
  from: number
  /** 结束行行尾。 */
  to: number
  /** 在讲解路线里的序号（从 1 开始）与总数。 */
  index: number
  total: number
  title: string
  text: string
  active: boolean
}

/** 整体替换当前文档的讲解锚点（打开文件、存储变化后按行号重锚）。 */
export const setWorkbenchExplanationAnchorsEffect =
  StateEffect.define<WorkbenchExplanationAnchor[]>()

export interface WorkbenchExplanationLabels {
  previous: string
  next: string
  close: string
  /** 行号栏标记的提示：当前这条点了收起，其余的点了展开。 */
  collapse: string
  expand: string
}

export interface WorkbenchExplanationExtensionOptions {
  onActivate: (id: string) => void
  onStep: (id: string, direction: 1 | -1) => void
  /** 收起当前气泡（气泡上的 ×、再点一次当前标记）。 */
  onCollapse: () => void
  /** 文案在 React 之外读取（widget 由 CodeMirror 构建），惰性取最新值。 */
  resolveLabels: () => WorkbenchExplanationLabels
  /** 锚住的代码被整段删掉。 */
  onAnchorsRemoved: (ids: string[]) => void
  /** 起止行随编辑变化。 */
  onAnchorLinesChanged: (updates: Array<{ id: string; startLine: number; endLine: number }>) => void
  /** 切文件 / 外部改动同步那种整篇替换：锚点作废但不算删除。 */
  isExternalDocReplace: (tr: Transaction) => boolean
}

/** 一段讲解最多给这么多行打底色；再长只标前面这些，免得装饰集膨胀。 */
const MaxHighlightedLines = 400

const ChevronLeftSvg =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M10 3.5 5.5 8 10 12.5"/></svg>'
const ChevronRightSvg =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M6 3.5 10.5 8 6 12.5"/></svg>'
const SparkleSvg =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 1.5c.3 2.9 1.6 4.2 4.5 4.5-2.9.3-4.2 1.6-4.5 4.5-.3-2.9-1.6-4.2-4.5-4.5C6.4 5.7 7.7 4.4 8 1.5Zm4.3 8.3c.15 1.3.75 1.9 2.05 2.05-1.3.15-1.9.75-2.05 2.05-.15-1.3-.75-1.9-2.05-2.05 1.3-.15 1.9-.75 2.05-2.05Z"/></svg>'
const CloseSvg =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="m4.5 4.5 7 7m0-7-7 7"/></svg>'

function stopEditorEvents(element: HTMLElement): void {
  // 气泡是独立交互面：事件到此为止，不让 CodeMirror 在下层挪光标、改选区。
  for (const eventName of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu'] as const)
    element.addEventListener(eventName, (event) => event.stopPropagation())
}

/** 正文按纯文本渲染，只认反引号包起来的代码片段；不解析 HTML。 */
function appendExplanationText(parent: HTMLElement, text: string): void {
  const parts = text.split(/(`[^`\n]+`)/u)
  for (const part of parts) {
    if (!part) continue
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code')
      code.textContent = part.slice(1, -1)
      parent.appendChild(code)
    } else {
      parent.appendChild(document.createTextNode(part))
    }
  }
}

function createActionButton(
  className: string,
  label: string,
  svg: string,
  action: () => void,
  disabled = false
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `cm-wbExplainAction ${className}`
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML = svg
  button.disabled = disabled
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!button.disabled) action()
  })
  return button
}

class WorkbenchExplanationBubbleWidget extends WidgetType {
  public constructor(
    private readonly anchor: WorkbenchExplanationAnchor,
    private readonly options: WorkbenchExplanationExtensionOptions
  ) {
    super()
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof WorkbenchExplanationBubbleWidget &&
      other.anchor.id === this.anchor.id &&
      other.anchor.index === this.anchor.index &&
      other.anchor.total === this.anchor.total &&
      other.anchor.title === this.anchor.title &&
      other.anchor.text === this.anchor.text
    )
  }

  public toDOM(): HTMLElement {
    const labels = this.options.resolveLabels()
    const { anchor } = this
    const root = document.createElement('div')
    root.className = 'cm-wbExplainBubble'
    root.setAttribute('data-explanation-id', anchor.id)
    root.setAttribute('role', 'note')
    stopEditorEvents(root)

    // 顶部一行：‹ 序号 › 标题 ×。窄的时候只让标题省略，按钮与序号不换行、不挤掉。
    const header = document.createElement('div')
    header.className = 'cm-wbExplainHeader'
    if (anchor.total > 1) {
      const counter = document.createElement('span')
      counter.className = 'cm-wbExplainCounter'
      counter.textContent = `${anchor.index}/${anchor.total}`
      header.append(
        createActionButton(
          'cm-wbExplainPrevious',
          labels.previous,
          ChevronLeftSvg,
          () => this.options.onStep(anchor.id, -1),
          anchor.index <= 1
        ),
        counter,
        createActionButton(
          'cm-wbExplainNext',
          labels.next,
          ChevronRightSvg,
          () => this.options.onStep(anchor.id, 1),
          anchor.index >= anchor.total
        )
      )
    }
    const title = document.createElement('span')
    title.className = 'cm-wbExplainTitle'
    title.textContent = anchor.title
    if (anchor.title) title.title = anchor.title
    header.append(
      title,
      createActionButton('cm-wbExplainClose', labels.close, CloseSvg, () => this.options.onCollapse())
    )
    root.appendChild(header)

    const body = document.createElement('div')
    body.className = 'cm-wbExplainBody'
    appendExplanationText(body, anchor.text)
    root.appendChild(body)
    return root
  }

  public ignoreEvent(): boolean {
    return true
  }
}

class WorkbenchExplanationGutterMarker extends GutterMarker {
  public constructor(
    private readonly anchor: WorkbenchExplanationAnchor,
    private readonly options: WorkbenchExplanationExtensionOptions
  ) {
    super()
  }

  public eq(other: GutterMarker): boolean {
    return (
      other instanceof WorkbenchExplanationGutterMarker &&
      other.anchor.id === this.anchor.id &&
      other.anchor.index === this.anchor.index &&
      other.anchor.active === this.anchor.active &&
      other.anchor.title === this.anchor.title
    )
  }

  public toDOM(): Node {
    const labels = this.options.resolveLabels()
    const marker = document.createElement('button')
    marker.type = 'button'
    marker.className = 'cm-wbExplainGutterMarker'
    marker.setAttribute('data-explanation-id', this.anchor.id)
    marker.setAttribute('data-active', String(this.anchor.active))
    const action = this.anchor.active ? labels.collapse : labels.expand
    const label = this.anchor.title ? `${action} · ${this.anchor.title}` : action
    marker.title = label
    marker.setAttribute('aria-label', label)
    marker.innerHTML = SparkleSvg
    marker.append(document.createTextNode(String(this.anchor.index)))
    stopEditorEvents(marker)
    marker.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.anchor.active) this.options.onCollapse()
      else this.options.onActivate(this.anchor.id)
    })
    return marker
  }
}

function buildExplanationDecorations(
  state: EditorState,
  anchors: readonly WorkbenchExplanationAnchor[],
  options: WorkbenchExplanationExtensionOptions
): { deco: DecorationSet; gutter: RangeSet<GutterMarker> } {
  const ranges: Array<Range<Decoration>> = []
  const markers: Array<Range<GutterMarker>> = []
  const doc = state.doc
  for (const anchor of anchors) {
    if (anchor.to > doc.length || anchor.from > anchor.to) continue
    const firstLine = doc.lineAt(anchor.from)
    const lastLine = doc.lineAt(anchor.to)
    markers.push(new WorkbenchExplanationGutterMarker(anchor, options).range(firstLine.from))
    if (anchor.active) {
      // 只给正在看的这一条着色；其余讲解只留行号栏标记，不把整篇代码染一片。
      const lastHighlighted = Math.min(lastLine.number, firstLine.number + MaxHighlightedLines - 1)
      for (let lineNumber = firstLine.number; lineNumber <= lastHighlighted; lineNumber += 1)
        ranges.push(Decoration.line({ class: 'cm-wbExplainLine' }).range(doc.line(lineNumber).from))
      ranges.push(
        Decoration.widget({
          widget: new WorkbenchExplanationBubbleWidget(anchor, options),
          block: true,
          side: 1,
        }).range(lastLine.to)
      )
    }
  }
  return { deco: Decoration.set(ranges, true), gutter: RangeSet.of(markers, true) }
}

interface WorkbenchExplanationFieldValue {
  anchors: WorkbenchExplanationAnchor[]
  deco: DecorationSet
  gutter: RangeSet<GutterMarker>
}

function sameAnchors(
  left: readonly WorkbenchExplanationAnchor[],
  right: readonly WorkbenchExplanationAnchor[]
): boolean {
  return (
    left.length === right.length &&
    left.every((anchor, index) => {
      const other = right[index]
      return (
        !!other &&
        anchor.id === other.id &&
        anchor.from === other.from &&
        anchor.to === other.to &&
        anchor.index === other.index &&
        anchor.total === other.total &&
        anchor.title === other.title &&
        anchor.text === other.text &&
        anchor.active === other.active
      )
    })
  )
}

export function createWorkbenchExplanationExtension(
  options: WorkbenchExplanationExtensionOptions
): Extension {
  const explanationField = StateField.define<WorkbenchExplanationFieldValue>({
    create: () => ({ anchors: [], deco: Decoration.none, gutter: RangeSet.empty }),
    update(value, tr) {
      let anchors = value.anchors
      if (tr.docChanged) {
        anchors = options.isExternalDocReplace(tr)
          ? []
          : anchors.flatMap((anchor) => mapWorkbenchLineAnchor(anchor, tr.changes, tr.newDoc) ?? [])
      }
      for (const effect of tr.effects) {
        if (!effect.is(setWorkbenchExplanationAnchorsEffect)) continue
        // 编辑器自己回写行号后，存储通知回来的重锚与眼下的锚点一致：不必重建气泡。
        const next = effect.value.filter((anchor) => anchor.to >= anchor.from)
        if (!sameAnchors(anchors, next)) anchors = next
      }
      if (anchors === value.anchors && !tr.docChanged) return value
      return { anchors, ...buildExplanationDecorations(tr.state, anchors, options) }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
  })

  const syncWatcher = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    if (update.transactions.some((tr) => options.isExternalDocReplace(tr))) return
    const before = update.startState.field(explanationField, false)
    const after = update.state.field(explanationField, false)
    if (!before || !after) return

    const afterIds = new Set(after.anchors.map((anchor) => anchor.id))
    const removed = before.anchors
      .filter((anchor) => !afterIds.has(anchor.id))
      .map((anchor) => anchor.id)
    if (!isEmpty(removed)) options.onAnchorsRemoved(removed)
    const lineUpdates = after.anchors.map((anchor) => ({
      id: anchor.id,
      startLine: update.state.doc.lineAt(anchor.from).number,
      endLine: resolveWorkbenchAnchorEndLine(update.state.doc, anchor),
    }))
    if (!isEmpty(lineUpdates)) options.onAnchorLinesChanged(lineUpdates)
  })

  /*
   * 气泡是 `.cm-content` 里的整宽块，而长代码行会把内容区撑得比可见区宽——不量一下，气泡就按内容宽度
   * 铺出去、右半截（连同按钮）落在视野外。这里把可见宽度与行号栏宽度写成 CSS 变量，气泡按它收窄，
   * 横向滚动时再贴住行号栏右侧。
   */
  const visibleWidthSync = ViewPlugin.fromClass(
    class {
      public constructor(view: EditorView) {
        this.schedule(view)
      }

      public update(update: ViewUpdate): void {
        if (update.geometryChanged) this.schedule(update.view)
      }

      private schedule(view: EditorView): void {
        view.requestMeasure({
          key: this,
          read: (current) => {
            const gutters = current.dom.querySelector<HTMLElement>('.cm-gutters')
            const gutterWidth = gutters?.offsetWidth ?? 0
            return { gutterWidth, visibleWidth: current.scrollDOM.clientWidth - gutterWidth }
          },
          write: ({ gutterWidth, visibleWidth }, current) => {
            current.dom.style.setProperty('--wb-explain-gutter-width', `${gutterWidth}px`)
            current.dom.style.setProperty('--wb-explain-visible-width', `${Math.max(0, visibleWidth)}px`)
          },
        })
      }
    }
  )

  const explanationGutter = gutter({
    class: 'cm-wbExplainGutter',
    markers: (view) => view.state.field(explanationField).gutter,
  })

  const explanationTheme = EditorView.theme({
    '.cm-wbExplainLine': {
      backgroundColor: 'var(--workbench-editor-explain-line-active-bg, rgba(99, 102, 241, 0.14))',
      boxShadow: 'inset 3px 0 0 var(--workbench-editor-explain-accent, #6366f1)',
    },
    '.cm-wbExplainGutter .cm-gutterElement': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 3px',
    },
    '.cm-wbExplainGutterMarker': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '2px',
      height: '16px',
      padding: '0 5px 0 4px',
      border: 'none',
      borderRadius: '8px',
      font: '600 10.5px/16px var(--workbench-font-sans, system-ui, sans-serif)',
      color: 'var(--workbench-editor-explain-accent, #6366f1)',
      backgroundColor: 'var(--workbench-editor-explain-marker-bg, rgba(99, 102, 241, 0.14))',
      cursor: 'pointer',
    },
    '.cm-wbExplainGutterMarker:hover': {
      backgroundColor: 'var(--workbench-editor-explain-marker-hover-bg, rgba(99, 102, 241, 0.24))',
    },
    '.cm-wbExplainGutterMarker[data-active="true"]': {
      color: '#ffffff',
      backgroundColor: 'var(--workbench-editor-explain-accent, #6366f1)',
    },
    '.cm-wbExplainBubble': {
      position: 'sticky',
      left: 'calc(var(--wb-explain-gutter-width, 0px) + 8px)',
      boxSizing: 'border-box',
      margin: '6px 16px 10px 16px',
      width: 'calc(var(--wb-explain-visible-width, 792px) - 32px)',
      minWidth: '220px',
      maxWidth: '760px',
      padding: '6px 8px 10px 12px',
      borderRadius: '10px',
      border: '1px solid var(--workbench-editor-explain-border, rgba(99, 102, 241, 0.35))',
      borderLeft: '3px solid var(--workbench-editor-explain-accent, #6366f1)',
      backgroundColor: 'var(--workbench-editor-tooltip-bg, #ffffff)',
      boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
      color: 'var(--workbench-editor-fg, #1f2937)',
      font: '13px/1.6 var(--workbench-font-sans, system-ui, sans-serif)',
      whiteSpace: 'normal',
      cursor: 'default',
    },
    '.cm-wbExplainHeader': {
      // 始终一行：翻页、序号、关闭都不收缩，只有标题在放不下时省略。
      display: 'flex',
      flexWrap: 'nowrap',
      alignItems: 'center',
      gap: '2px',
      minWidth: '0',
      marginBottom: '4px',
    },
    '.cm-wbExplainCounter': {
      flex: 'none',
      minWidth: '2.2em',
      textAlign: 'center',
      fontSize: '11px',
      fontVariantNumeric: 'tabular-nums',
      opacity: '0.7',
    },
    '.cm-wbExplainTitle': {
      flex: '1 1 auto',
      minWidth: '0',
      margin: '0 6px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontWeight: '600',
    },
    '.cm-wbExplainTitle:first-child': {
      marginLeft: '0',
    },
    '.cm-wbExplainAction': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
      width: '22px',
      height: '22px',
      padding: '0',
      border: 'none',
      borderRadius: '6px',
      color: 'inherit',
      backgroundColor: 'transparent',
      cursor: 'pointer',
    },
    '.cm-wbExplainClose': {
      opacity: '0.7',
    },
    '.cm-wbExplainClose:hover': {
      opacity: '1',
    },
    '.cm-wbExplainAction:hover:not(:disabled)': {
      backgroundColor: 'var(--workbench-editor-explain-marker-bg, rgba(99, 102, 241, 0.14))',
    },
    '.cm-wbExplainAction:disabled': {
      opacity: '0.35',
      cursor: 'default',
    },
    '.cm-wbExplainBody': {
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
    '.cm-wbExplainBody code': {
      padding: '0 4px',
      borderRadius: '4px',
      font: '12px/1.6 var(--workbench-font-mono, ui-monospace, monospace)',
      backgroundColor: 'var(--workbench-editor-explain-code-bg, rgba(99, 102, 241, 0.1))',
    },
  })

  return [explanationField, syncWatcher, visibleWidthSync, explanationGutter, explanationTheme]
}

/**
 * 按存储里的行号把讲解换算成当前文档的锚点；越界的讲解（文件已被改短）略过。
 * `explanations` 已按讲解路线排好，序号与总数按整条路线计。
 */
export function buildWorkbenchExplanationAnchors(
  doc: { lines: number; line: (n: number) => { from: number; to: number } },
  path: string,
  explanations: ReadonlyArray<{
    id: string
    path: string
    startLine: number
    endLine: number
    title: string
    text: string
  }>,
  activeId: string | null
): WorkbenchExplanationAnchor[] {
  const anchors: WorkbenchExplanationAnchor[] = []
  explanations.forEach((explanation, index) => {
    if (explanation.path !== path) return
    if (explanation.startLine < 1 || explanation.startLine > doc.lines) return
    const endLine = Math.min(Math.max(explanation.startLine, explanation.endLine), doc.lines)
    const from = doc.line(explanation.startLine).from
    const to = doc.line(endLine).to
    anchors.push({
      id: explanation.id,
      from,
      to,
      index: index + 1,
      total: explanations.length,
      title: explanation.title,
      text: explanation.text,
      active: explanation.id === activeId,
    })
  })
  return anchors
}
