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
  collectWorkbenchDiffChangeAnchors,
  type WorkbenchUnifiedDiffRow,
} from '@renderer/models/git/workbenchGitDiffModel'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import { isEmpty, isNotNull } from '@velaros-ai/core'

import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'

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

interface ReadOnlyDiffCodeMirrorProps {
  rows: WorkbenchUnifiedDiffRow[]
  path: Nullable<string>
  workbenchTheme: WorkbenchThemeId
  hunkActions?: Nullable<ReadOnlyDiffHunkActions>
}

class DiffGutterMarker extends GutterMarker {
  /** 让 gutter 行元素也带上增删底色（CodeMirror 的行装饰只作用于代码行，不含 gutter）。 */
  public readonly elementClass: string

  constructor(
    private readonly oldNum: string,
    private readonly newNum: string,
    kind: WorkbenchUnifiedDiffRow['kind']
  ) {
    super()
    this.elementClass =
      kind === 'addition' ? 'cm-diffGutterAdd' : kind === 'deletion' ? 'cm-diffGutterDel' : ''
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
    const oldEl = document.createElement('span')
    oldEl.className = 'cm-diffGutterOld'
    oldEl.textContent = this.oldNum
    const newEl = document.createElement('span')
    newEl.className = 'cm-diffGutterNew'
    newEl.textContent = this.newNum
    cell.append(oldEl, newEl)
    return cell
  }
}

/** 块上方那一排按钮：点下去交给当前的 `onAction`（经 `readHandler` 取，视图重建前后都是最新的）。 */
class DiffHunkActionsWidget extends WidgetType {
  public constructor(
    private readonly hunk: number,
    private readonly actions: readonly ReadOnlyDiffHunkAction[],
    private readonly disabled: boolean,
    private readonly readHandler: () => Nullable<ReadOnlyDiffHunkActions['onAction']>
  ) {
    super()
  }

  public override eq(other: DiffHunkActionsWidget): boolean {
    return (
      other.hunk === this.hunk &&
      other.disabled === this.disabled &&
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
    for (const action of this.actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = action.destructive
        ? 'cm-diffHunkAction cm-diffHunkAction-destructive'
        : 'cm-diffHunkAction'
      button.textContent = action.label
      button.disabled = this.disabled
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', (event) => {
        event.preventDefault()
        this.readHandler()?.(this.hunk, action.id)
      })
      bar.append(button)
    }
    return bar
  }

  public override ignoreEvent(): boolean {
    return true
  }
}

const setHunkActionsEffect = StateEffect.define<Nullable<ReadOnlyDiffHunkActions>>()

function buildDiffDecorations(
  state: EditorState,
  rows: WorkbenchUnifiedDiffRow[],
  hunkActions: Nullable<ReadOnlyDiffHunkActions>,
  readHandler: () => Nullable<ReadOnlyDiffHunkActions['onAction']>
): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  const lineCount = state.doc.lines
  const hunksWithActions = new Set<number>()

  rows.forEach((row, index) => {
    if (index + 1 > lineCount) return
    const line = state.doc.line(index + 1)

    const changed = row.kind === 'addition' || row.kind === 'deletion'
    // 按钮放在每块第一处增删的上方。
    if (hunkActions && changed && row.hunk !== undefined && !hunksWithActions.has(row.hunk)) {
      hunksWithActions.add(row.hunk)
      ranges.push(
        Decoration.widget({
          widget: new DiffHunkActionsWidget(
            row.hunk,
            hunkActions.actions,
            hunkActions.disabled,
            readHandler
          ),
          block: true,
          side: -1,
        }).range(line.from)
      )
    }
    const lineClass =
      row.kind === 'addition' ? 'cm-diffLineAdd' : row.kind === 'deletion' ? 'cm-diffLineDel' : null
    if (lineClass) {
      ranges.push(Decoration.line({ attributes: { class: lineClass } }).range(line.from))
    }
  })

  return Decoration.set(ranges, true)
}

/**
 * 只读的语法高亮 diff：把统一 diff 渲染进 CodeMirror，语法高亮（前景色）与
 * 增删底色由 CodeMirror 行装饰提供；左侧 gutter 只保留
 * 旧/新两列行号，不再有 +/- 标记列。给了 `hunkActions` 时每块改动上方有一排按钮（暂存、回滚这一块）。
 */
export const ReadOnlyDiffCodeMirror = forwardRef<
  ReadOnlyDiffCodeMirrorHandle,
  ReadOnlyDiffCodeMirrorProps
>(function ReadOnlyDiffCodeMirror(
  { rows, path, workbenchTheme, hunkActions = null },
  ref
): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<Nullable<EditorView>>(null)
  const anchorsRef = useRef<number[]>([])
  const cursorRef = useRef(-1)
  const hunkActionsRef = useLatest(hunkActions)
  /** 同一个文件的差异重读后重建视图：接着停在原来滚到的地方。 */
  const scrollRef = useRef<Nullable<{ path: Nullable<string>; top: number }>>(null)
  const editorMetricsCompartment = useMemo(() => new Compartment(), [])
  const editorMetrics = useWorkbenchEditorMetrics()

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    refreshWorkbenchCodeMirrorMetrics(view, editorMetricsCompartment, editorMetrics)
  }, [editorMetrics, editorMetricsCompartment])

  useImperativeHandle(
    ref,
    () => ({
      goToChange: (direction: 1 | -1): void => {
        const view = viewRef.current
        const anchors = anchorsRef.current
        if (!view || isEmpty(anchors)) return

        let next = cursorRef.current + direction
        if (next < 0) next = anchors.length - 1
        if (next >= anchors.length) next = 0
        cursorRef.current = next

        const lineNumber = anchors[next]
        if (lineNumber > view.state.doc.lines) return
        const pos = view.state.doc.line(lineNumber).from
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      },
    }),
    []
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const language = resolveWorkbenchCodeMirrorLanguage(path, '')
    const doc = rows.map((row) => row.text).join('\n')
    anchorsRef.current = collectWorkbenchDiffChangeAnchors(rows)
    cursorRef.current = -1
    const readHandler = (): Nullable<ReadOnlyDiffHunkActions['onAction']> =>
      hunkActionsRef.current?.onAction ?? null

    const decorationField = StateField.define<DecorationSet>({
      create: (state) => buildDiffDecorations(state, rows, hunkActionsRef.current, readHandler),
      update: (value, tr) => {
        for (const effect of tr.effects) {
          if (effect.is(setHunkActionsEffect))
            return buildDiffDecorations(tr.state, rows, effect.value, readHandler)
        }
        return value
      },
      provide: (field) => EditorView.decorations.from(field),
    })

    const diffGutter = gutter({
      class: 'cm-diffGutter',
      lineMarker: (view, line) => {
        const lineNumber = view.state.doc.lineAt(line.from).number
        const row = rows[lineNumber - 1]
        if (!row) return null
        return new DiffGutterMarker(
          isNotNull(row.oldLine) ? String(row.oldLine) : '',
          isNotNull(row.newLine) ? String(row.newLine) : '',
          row.kind
        )
      },
      lineMarkerChange: () => false,
    })

    const extensions: Extension[] = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      diffGutter,
      decorationField,
      language.extension,
      editorMetricsCompartment.of(createWorkbenchCodeMirrorMetricsExtension(editorMetrics)),
      getWorkbenchCodeMirrorTheme(workbenchTheme),
    ]

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc, extensions }),
    })
    viewRef.current = view
    const saved = scrollRef.current
    const frame =
      saved && saved.path === path
        ? window.requestAnimationFrame(() => {
            view.scrollDOM.scrollTop = saved.top
          })
        : null

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      scrollRef.current = { path, top: view.scrollDOM.scrollTop }
      view.destroy()
      viewRef.current = null
    }
  }, [editorMetricsCompartment, hunkActionsRef, path, rows, workbenchTheme])

  // 按钮的开关（处理中禁用）、文字变了：只换装饰，不重建视图。
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setHunkActionsEffect.of(hunkActions) })
  }, [hunkActions])

  return (
    <div
      ref={hostRef}
      className={`${styles.editorHistoryCodeViewer} ${styles.workbenchUnifiedDiffCode}`}
    />
  )
})
