import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, type Extension, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, gutter, GutterMarker } from '@codemirror/view'

import { isEmpty, isNotNull } from '@velaros-ai/core'
import { resolveWorkbenchCodeMirrorLanguage } from '@velaros-ai/workbench/models/editor/workbenchCodeMirrorLanguage'
import { getWorkbenchCodeMirrorTheme } from '@velaros-ai/workbench/models/editor/workbenchCodeMirrorTheme'
import { useWorkbenchLanguagePluginRuntime } from '@velaros-ai/workbench/models/editor/WorkbenchLanguagePluginRuntimeProvider'
import type { WorkbenchUnifiedDiffRow } from '@velaros-ai/workbench/models/git/workbenchGitDiffModel'
import type { WorkbenchThemeId } from '@velaros-ai/workbench/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'

export interface ReadOnlyDiffCodeMirrorHandle {
  /** 跳到上一处（-1）/下一处（1）变更块并居中。 */
  goToChange: (direction: 1 | -1) => void
}

interface ReadOnlyDiffCodeMirrorProps {
  rows: WorkbenchUnifiedDiffRow[]
  path: Nullable<string>
  workbenchTheme: WorkbenchThemeId
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

function buildDiffDecorations(state: EditorState, rows: WorkbenchUnifiedDiffRow[]): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  const lineCount = state.doc.lines

  rows.forEach((row, index) => {
    if (index + 1 > lineCount) return
    const line = state.doc.line(index + 1)

    const lineClass =
      row.kind === 'addition' ? 'cm-diffLineAdd' : row.kind === 'deletion' ? 'cm-diffLineDel' : null
    if (lineClass) {
      ranges.push(Decoration.line({ attributes: { class: lineClass } }).range(line.from))
    }
  })

  return Decoration.set(ranges, true)
}

/** 变更块起始行号（1-indexed doc 行），供上一处/下一处导航定位。 */
function collectChangeAnchors(rows: WorkbenchUnifiedDiffRow[]): number[] {
  const anchors: number[] = []
  rows.forEach((row, index) => {
    const isChange = row.kind === 'addition' || row.kind === 'deletion'
    const prev = rows[index - 1]
    const prevChange = !!prev && (prev.kind === 'addition' || prev.kind === 'deletion')
    if (isChange && !prevChange) anchors.push(index + 1)
  })
  return anchors
}

/**
 * 只读的语法高亮 diff：把统一 diff 渲染进 CodeMirror，语法高亮（前景色）与
 * 增删底色由 CodeMirror 行装饰提供；左侧 gutter 只保留
 * 旧/新两列行号，不再有 +/- 标记列。
 */
export const ReadOnlyDiffCodeMirror = forwardRef<
  ReadOnlyDiffCodeMirrorHandle,
  ReadOnlyDiffCodeMirrorProps
>(function ReadOnlyDiffCodeMirror({ rows, path, workbenchTheme }, ref): React.ReactElement {
  const languagePluginRuntime = useWorkbenchLanguagePluginRuntime()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<Nullable<EditorView>>(null)
  const anchorsRef = useRef<number[]>([])
  const cursorRef = useRef(-1)

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

    const language = resolveWorkbenchCodeMirrorLanguage(
      path,
      '',
      languagePluginRuntime.readDownloadedPluginIds()
    )
    const doc = rows.map((row) => row.text).join('\n')
    anchorsRef.current = collectChangeAnchors(rows)
    cursorRef.current = -1

    const decorationField = StateField.define<DecorationSet>({
      create: (state) => buildDiffDecorations(state, rows),
      update: (value) => value,
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
      getWorkbenchCodeMirrorTheme(workbenchTheme),
    ]

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc, extensions }),
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [languagePluginRuntime, rows, path, workbenchTheme])

  return (
    <div
      ref={hostRef}
      className={`${styles.editorHistoryCodeViewer} ${styles.workbenchUnifiedDiffCode}`}
    />
  )
})
