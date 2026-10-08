import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import {
  Compartment,
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
} from '@codemirror/view'
import { useWorkbenchEditorMetrics } from '@renderer/hooks/useWorkbenchPreferences'
import { resolveWorkbenchCodeMirrorLanguage } from '@renderer/models/editor/workbenchCodeMirrorLanguage'
import {
  createWorkbenchCodeMirrorMetricsExtension,
  refreshWorkbenchCodeMirrorMetrics,
} from '@renderer/models/editor/workbenchCodeMirrorMetrics'
import { getWorkbenchCodeMirrorTheme } from '@renderer/models/editor/workbenchCodeMirrorTheme'
import {
  computeWorkbenchDiffInlineChanges,
  type WorkbenchDiffInlineChanges,
} from '@renderer/models/git/workbenchDiffInlineChanges'
import {
  buildWorkbenchDiffPaneLayout,
  getWorkbenchDiffPaneText,
  type WorkbenchDiffPane,
} from '@renderer/models/git/workbenchDiffSideBySide'
import type { WorkbenchUnifiedDiffRow } from '@renderer/models/git/workbenchGitDiffModel'
import type {
  WorkbenchDiffLayout,
  WorkbenchThemeId,
} from '@renderer/models/workbenchPreferences'

import { isEmpty, isNotNull } from '@velaros-ai/core'

import styles from '../../styles/workbenchPageStyles'
import { useLatest, useMemoizedFn } from '../../support/genericHooks'

export interface ReadOnlyDiffCodeMirrorHandle {
  /** 跳到上一处（-1）/下一处（1）变更块并居中。 */
  goToChange: (direction: 1 | -1) => void
}

export interface ReadOnlyDiffHunkAction {
  id: string
  label: string
  /** 会丢掉改动的（回滚）：红字。 */
  destructive?: boolean
}

/** 每块改动上方的一排按钮（按 git 补丁铺的行才有块，见 `WorkbenchUnifiedDiffRow.hunk`）。 */
export interface ReadOnlyDiffHunkActions {
  actions: readonly ReadOnlyDiffHunkAction[]
  /** 正在处理某一块时整排按钮先禁用。 */
  disabled: boolean
  onAction: (hunk: number, actionId: string) => void
}

export interface ReadOnlyDiffCodeMirrorProps {
  rows: WorkbenchUnifiedDiffRow[]
  path: Nullable<string>
  workbenchTheme: WorkbenchThemeId
  hunkActions?: Nullable<ReadOnlyDiffHunkActions>
  /** 改动前后上下合在一栏（默认），或者左右并排。 */
  layout?: WorkbenchDiffLayout
}

class DiffGutterMarker extends GutterMarker {
  /** 让 gutter 行元素也带上增删底色（CodeMirror 的行装饰只作用于代码行，不含 gutter）。 */
  public readonly elementClass: string

  /** `oldNum` / `newNum` 为 null：这一栏没有这一列行号（并排时左栏只有旧行号、右栏只有新行号）。 */
  constructor(
    private readonly oldNum: Nullable<string>,
    private readonly newNum: Nullable<string>,
    kind: WorkbenchUnifiedDiffRow['kind'] | 'filler'
  ) {
    super()
    this.elementClass =
      kind === 'addition'
        ? 'cm-diffGutterAdd'
        : kind === 'deletion'
          ? 'cm-diffGutterDel'
          : kind === 'filler'
            ? 'cm-diffGutterFiller'
            : ''
  }

  public eq(other: DiffGutterMarker): boolean {
    return (
      other.oldNum === this.oldNum &&
      other.newNum === this.newNum &&
      other.elementClass === this.elementClass
    )
  }

  public toDOM(): HTMLElement {
    const cell = document.createElement('div')
    cell.className = 'cm-diffGutterCell'
    // 只有一列行号时它两边的留白都要：把两列的样式都给它。
    const single = this.oldNum === null || this.newNum === null
    for (const [text, className] of [
      [this.oldNum, 'cm-diffGutterOld'],
      [this.newNum, 'cm-diffGutterNew'],
    ] as const) {
      if (text === null) continue
      const element = document.createElement('span')
      element.className = single ? 'cm-diffGutterOld cm-diffGutterNew' : className
      element.textContent = text
      cell.append(element)
    }
    return cell
  }
}

/**
 * 块上方那一排按钮：点下去交给当前的 `onAction`（经 `readHandler` 取，视图重建前后都是最新的）。
 * `placeholder` 为 true 时画一份看不见、点不到的，只为了跟对面那一栏的按钮一样高。
 */
class DiffHunkActionsWidget extends WidgetType {
  public constructor(
    private readonly hunk: number,
    private readonly actions: readonly ReadOnlyDiffHunkAction[],
    private readonly disabled: boolean,
    private readonly placeholder: boolean,
    private readonly readHandler: () => Nullable<ReadOnlyDiffHunkActions['onAction']>
  ) {
    super()
  }

  public override eq(other: DiffHunkActionsWidget): boolean {
    return (
      other.hunk === this.hunk &&
      other.disabled === this.disabled &&
      other.placeholder === this.placeholder &&
      other.actions.length === this.actions.length &&
      other.actions.every(
        (action, index) =>
          action.id === this.actions[index]?.id && action.label === this.actions[index]?.label
      )
    )
  }

  public override toDOM(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-diffHunkActions'
    if (this.placeholder) {
      bar.style.visibility = 'hidden'
      bar.setAttribute('aria-hidden', 'true')
    }
    for (const action of this.actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = action.destructive
        ? 'cm-diffHunkAction cm-diffHunkAction-destructive'
        : 'cm-diffHunkAction'
      button.textContent = action.label
      button.disabled = this.disabled || this.placeholder
      if (!this.placeholder) {
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', (event) => {
          event.preventDefault()
          this.readHandler()?.(this.hunk, action.id)
        })
      }
      bar.append(button)
    }
    return bar
  }

  public override ignoreEvent(): boolean {
    return true
  }
}

const setHunkActionsEffect = StateEffect.define<Nullable<ReadOnlyDiffHunkActions>>()

const LineDecorations = {
  addition: Decoration.line({ attributes: { class: 'cm-diffLineAdd' } }),
  deletion: Decoration.line({ attributes: { class: 'cm-diffLineDel' } }),
  filler: Decoration.line({ attributes: { class: 'cm-diffLineFiller' } }),
}
/** 行里变了的那几个词：比整行的底色更深的一层。 */
const WordDecorations = {
  addition: Decoration.mark({ class: 'cm-diffWordAdd' }),
  deletion: Decoration.mark({ class: 'cm-diffWordDel' }),
}
const FillerGutterMarker = new DiffGutterMarker(null, null, 'filler')

/**
 * 一栏的装饰：增删行的底色、占位行的斜纹、行里变了的词、每块上方的按钮（或者同样高的空位）。
 * `state` 的正文是这一栏的正文（{@link getWorkbenchDiffPaneText}）。
 */
export function buildReadOnlyDiffDecorations(
  state: EditorState,
  rows: readonly WorkbenchUnifiedDiffRow[],
  pane: WorkbenchDiffPane,
  inlineChanges: WorkbenchDiffInlineChanges,
  hunkLines: ReadonlyMap<number, number>,
  hunkActions: Nullable<ReadOnlyDiffHunkActions>,
  readHandler: () => Nullable<ReadOnlyDiffHunkActions['onAction']>
): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  const lineCount = state.doc.lines

  pane.rowIndexes.forEach((rowIndex, lineIndex) => {
    if (lineIndex + 1 > lineCount) return
    const line = state.doc.line(lineIndex + 1)

    // 按钮放在每块第一处增删的上方。
    const hunk = hunkLines.get(lineIndex)
    if (hunkActions && hunk !== undefined)
      ranges.push(
        Decoration.widget({
          widget: new DiffHunkActionsWidget(
            hunk,
            hunkActions.actions,
            hunkActions.disabled,
            pane.hunkBar === 'placeholder',
            readHandler
          ),
          block: true,
          side: -1,
        }).range(line.from)
      )

    if (rowIndex === null) {
      ranges.push(LineDecorations.filler.range(line.from))
      return
    }
    const { kind } = rows[rowIndex]
    if (kind !== 'addition' && kind !== 'deletion') return
    ranges.push(LineDecorations[kind].range(line.from))
    for (const change of inlineChanges.get(rowIndex) ?? []) {
      if (change.from < change.to && change.to <= line.length)
        ranges.push(WordDecorations[kind].range(line.from + change.from, line.from + change.to))
    }
  })

  return Decoration.set(ranges, true)
}

function createDiffPaneView(options: {
  parent: HTMLElement
  pane: WorkbenchDiffPane
  rows: readonly WorkbenchUnifiedDiffRow[]
  inlineChanges: WorkbenchDiffInlineChanges
  hunkLines: ReadonlyMap<number, number>
  extensions: Extension[]
  readHunkActions: () => Nullable<ReadOnlyDiffHunkActions>
}): EditorView {
  const { pane, rows } = options
  const readHandler = (): Nullable<ReadOnlyDiffHunkActions['onAction']> =>
    options.readHunkActions()?.onAction ?? null
  const decorate = (
    state: EditorState,
    hunkActions: Nullable<ReadOnlyDiffHunkActions>
  ): DecorationSet =>
    buildReadOnlyDiffDecorations(
      state,
      rows,
      pane,
      options.inlineChanges,
      options.hunkLines,
      hunkActions,
      readHandler
    )

  const decorationField = StateField.define<DecorationSet>({
    create: (state) => decorate(state, options.readHunkActions()),
    update: (value, tr) => {
      for (const effect of tr.effects) {
        if (effect.is(setHunkActionsEffect)) return decorate(tr.state, effect.value)
      }
      return value
    },
    provide: (field) => EditorView.decorations.from(field),
  })

  const lineNumber = (value: Nullable<number>): string => (isNotNull(value) ? String(value) : '')
  const diffGutter = gutter({
    class: 'cm-diffGutter',
    lineMarker: (view, line) => {
      const rowIndex = pane.rowIndexes[view.state.doc.lineAt(line.from).number - 1]
      if (rowIndex === undefined) return null
      if (rowIndex === null) return FillerGutterMarker
      const row = rows[rowIndex]
      return new DiffGutterMarker(
        pane.side === 'new' ? null : lineNumber(row.oldLine),
        pane.side === 'old' ? null : lineNumber(row.newLine),
        row.kind
      )
    },
    lineMarkerChange: () => false,
  })

  return new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: getWorkbenchDiffPaneText(rows, pane),
      extensions: [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        diffGutter,
        decorationField,
        ...options.extensions,
      ],
    }),
  })
}

/**
 * 并排的两栏一起滚：一栏滚到哪，另一栏跟到哪（上下、左右都跟）。跟过去的那一下也会触发滚动事件，
 * 认出它（位置就是刚写进去的那个）就不再传回来；两栏能滚的范围不一样（一栏有横向滚动条）时才不会来回弹。
 */
function linkDiffPaneScroll(first: EditorView, second: EditorView): () => void {
  const written = new Map<HTMLElement, { top: number; left: number }>()
  const follow = (source: HTMLElement, target: HTMLElement) => (): void => {
    const echo = written.get(source)
    written.delete(source)
    if (echo && echo.top === source.scrollTop && echo.left === source.scrollLeft) return
    if (target.scrollTop === source.scrollTop && target.scrollLeft === source.scrollLeft) return
    target.scrollTop = source.scrollTop
    target.scrollLeft = source.scrollLeft
    written.set(target, { top: target.scrollTop, left: target.scrollLeft })
  }
  const onFirst = follow(first.scrollDOM, second.scrollDOM)
  const onSecond = follow(second.scrollDOM, first.scrollDOM)
  first.scrollDOM.addEventListener('scroll', onFirst, { passive: true })
  second.scrollDOM.addEventListener('scroll', onSecond, { passive: true })
  return () => {
    first.scrollDOM.removeEventListener('scroll', onFirst)
    second.scrollDOM.removeEventListener('scroll', onSecond)
  }
}

/** 视图顶上正对着差异行里的哪一行，和这一行已经滚过去多少。 */
interface DiffScrollPosition {
  path: Nullable<string>
  row: number
  offset: number
}

function readDiffScrollPosition(
  view: EditorView,
  panes: readonly WorkbenchDiffPane[],
  path: Nullable<string>
): DiffScrollPosition {
  const top = view.scrollDOM.scrollTop
  const block = view.lineBlockAtHeight(top)
  const line = view.state.doc.lineAt(block.from).number - 1
  // 主栏在这一行是占位行时，看另一栏在这一行对着哪一行。
  const row = panes.at(-1)?.rowIndexes[line] ?? panes[0]?.rowIndexes[line] ?? 0
  return { path, row, offset: top - block.top }
}

function restoreDiffScrollPosition(
  view: EditorView,
  panes: readonly WorkbenchDiffPane[],
  position: DiffScrollPosition
): void {
  let line = panes.at(-1)?.rowIndexes.indexOf(position.row) ?? -1
  if (line < 0) line = panes[0]?.rowIndexes.indexOf(position.row) ?? -1
  if (line < 0 || line >= view.state.doc.lines) return
  view.scrollDOM.scrollTop =
    view.lineBlockAt(view.state.doc.line(line + 1).from).top + position.offset
}

/**
 * 只读的语法高亮 diff：把差异行渲染进 CodeMirror，语法高亮（前景色）与增删底色由 CodeMirror 行装饰提供，
 * 改过的行里变了的词再深一层；左侧 gutter 只有行号，没有 +/- 标记列。给了 `hunkActions` 时每块改动上方
 * 有一排按钮（暂存、回滚这一块）。
 *
 * `layout` 为 `split` 时左右两栏并排：左栏是改动前（只有旧行号），右栏是改动后（只有新行号），一起滚。
 * 两栏的行一一对齐——一侧多出来的行在另一侧是空的占位行，块上方的按钮在右栏、左栏留同样高的空。
 * 同一个文件的差异重读、换排法之后，接着停在原来看的那一行。
 */
export const ReadOnlyDiffCodeMirror = forwardRef<
  ReadOnlyDiffCodeMirrorHandle,
  ReadOnlyDiffCodeMirrorProps
>(function ReadOnlyDiffCodeMirror(
  { rows, path, workbenchTheme, hunkActions = null, layout = 'unified' },
  ref
): React.ReactElement {
  const primaryHostRef = useRef<HTMLDivElement>(null)
  const secondaryHostRef = useRef<HTMLDivElement>(null)
  /** 建好的视图，主栏在最后；还没建好时是空的。 */
  const viewsRef = useRef<EditorView[]>([])
  const anchorsRef = useRef<number[]>([])
  const cursorRef = useRef(-1)
  /** 视图还没建好时就要跳到某一处改动（刚打开差异、查看器的代码还在加载）：建好之后补上。 */
  const pendingDirectionRef = useRef<Nullable<1 | -1>>(null)
  const hunkActionsRef = useLatest(hunkActions)
  const scrollRef = useRef<Nullable<DiffScrollPosition>>(null)
  const editorMetricsCompartment = useMemo(() => new Compartment(), [])
  const editorMetrics = useWorkbenchEditorMetrics()
  const editorMetricsRef = useLatest(editorMetrics)
  const inlineChanges = useMemo(() => computeWorkbenchDiffInlineChanges(rows), [rows])

  useLayoutEffect(() => {
    for (const view of viewsRef.current)
      refreshWorkbenchCodeMirrorMetrics(view, editorMetricsCompartment, editorMetrics)
  }, [editorMetrics, editorMetricsCompartment])

  const goToChange = useMemoizedFn((direction: 1 | -1): void => {
    const view = viewsRef.current.at(-1)
    if (!view) {
      pendingDirectionRef.current = direction
      return
    }
    const anchors = anchorsRef.current
    if (isEmpty(anchors)) return

    let next = cursorRef.current + direction
    if (next < 0) next = anchors.length - 1
    if (next >= anchors.length) next = 0
    cursorRef.current = next

    const lineNumber = anchors[next]
    if (lineNumber > view.state.doc.lines) return
    const pos = view.state.doc.line(lineNumber).from
    // 并排时只滚主栏，另一栏跟着它。
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  })

  useImperativeHandle(ref, () => ({ goToChange }), [goToChange])

  useEffect(() => {
    const primaryHost = primaryHostRef.current
    const secondaryHost = secondaryHostRef.current
    if (!primaryHost || !secondaryHost) return

    const paneLayout = buildWorkbenchDiffPaneLayout(rows, layout)
    const { panes } = paneLayout
    anchorsRef.current = paneLayout.anchors
    cursorRef.current = -1

    const extensions: Extension[] = [
      resolveWorkbenchCodeMirrorLanguage(path, '').extension,
      editorMetricsCompartment.of(
        createWorkbenchCodeMirrorMetricsExtension(editorMetricsRef.current)
      ),
      getWorkbenchCodeMirrorTheme(workbenchTheme),
    ]
    const hosts = panes.length > 1 ? [secondaryHost, primaryHost] : [primaryHost]
    const views = panes.map((pane, index) =>
      createDiffPaneView({
        parent: hosts[index],
        pane,
        rows,
        inlineChanges,
        hunkLines: paneLayout.hunkLines,
        extensions,
        readHunkActions: () => hunkActionsRef.current,
      })
    )
    viewsRef.current = views
    const primary = views[views.length - 1]
    const unlinkScroll = views.length > 1 ? linkDiffPaneScroll(views[0], primary) : null

    // 视图建好之前就要的跳转现在补上；没有的话，同一个文件接着停在原来看的那一行。
    const pendingDirection = pendingDirectionRef.current
    pendingDirectionRef.current = null
    const saved = scrollRef.current
    let frame: Nullable<number> = null
    if (pendingDirection !== null) goToChange(pendingDirection)
    else if (saved && saved.path === path)
      frame = window.requestAnimationFrame(() => restoreDiffScrollPosition(primary, panes, saved))

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      unlinkScroll?.()
      // 整个查看器被卸掉时宿主元素已经摘下来了，量不出位置，也用不着记。
      if (primary.dom.isConnected)
        scrollRef.current = readDiffScrollPosition(primary, panes, path)
      for (const view of views) view.destroy()
      viewsRef.current = []
    }
  }, [
    editorMetricsCompartment,
    editorMetricsRef,
    goToChange,
    hunkActionsRef,
    inlineChanges,
    layout,
    path,
    rows,
    workbenchTheme,
  ])

  // 按钮的开关（处理中禁用）、文字变了：只换装饰，不重建视图。
  useEffect(() => {
    for (const view of viewsRef.current)
      view.dispatch({ effects: setHunkActionsEffect.of(hunkActions) })
  }, [hunkActions])

  const paneClassName = `${styles.editorHistoryCodeViewer} ${styles.workbenchUnifiedDiffCode}`
  // 两个宿主元素一直都在（上下排时第二栏藏着、里面没有视图）：换排法时 React 不会先把旧的元素摘掉，
  // 收场时还读得到滚动位置。
  return (
    <div className={styles.workbenchDiffPanes} data-layout={layout}>
      <div ref={secondaryHostRef} className={paneClassName} data-pane="secondary" />
      <div ref={primaryHostRef} className={paneClassName} data-pane="primary" />
    </div>
  )
})
