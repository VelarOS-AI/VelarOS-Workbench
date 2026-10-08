import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { useWorkbenchEditorMetrics } from '@renderer/hooks/useWorkbenchPreferences'
import { buildReadOnlyCodeSearchHighlight } from '@renderer/models/editor/readOnlyCodeSearchHighlight'
import { resolveWorkbenchCodeMirrorLanguage } from '@renderer/models/editor/workbenchCodeMirrorLanguage'
import {
  createWorkbenchCodeMirrorMetricsExtension,
  refreshWorkbenchCodeMirrorMetrics,
} from '@renderer/models/editor/workbenchCodeMirrorMetrics'
import { getWorkbenchCodeMirrorTheme } from '@renderer/models/editor/workbenchCodeMirrorTheme'
import type { WorkbenchThemeId } from '@renderer/models/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'

export function ReadOnlyWorkbenchCode({
  content,
  path,
  workbenchTheme,
  highlightQuery = '',
  initialLine,
  showLineNumbers = true,
  compact = false,
}: {
  content: string
  path: Nullable<string>
  workbenchTheme: WorkbenchThemeId
  highlightQuery?: string
  initialLine?: number
  showLineNumbers?: boolean
  compact?: boolean
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<Nullable<EditorView>>(null)
  const editorMetricsCompartment = useMemo(() => new Compartment(), [])
  const editorMetrics = useWorkbenchEditorMetrics()

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    refreshWorkbenchCodeMirrorMetrics(view, editorMetricsCompartment, editorMetrics)
  }, [editorMetrics, editorMetricsCompartment])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const language = resolveWorkbenchCodeMirrorLanguage(path, '')
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          ...(showLineNumbers ? [lineNumbers()] : []),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          language.extension,
          editorMetricsCompartment.of(createWorkbenchCodeMirrorMetricsExtension(editorMetrics)),
          getWorkbenchCodeMirrorTheme(workbenchTheme),
          buildReadOnlyCodeSearchHighlight(highlightQuery),
        ],
      }),
    })
    if (initialLine) {
      const line = view.state.doc.line(Math.max(1, Math.min(initialLine, view.state.doc.lines)))
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      })
    }
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [
    content,
    editorMetricsCompartment,
    highlightQuery,
    initialLine,
    path,
    showLineNumbers,
    workbenchTheme,
  ])

  return (
    <div
      ref={hostRef}
      className={`${styles.editorHistoryCodeViewer}${compact ? ` ${styles.editorHistoryCodeViewerCompact}` : ''}`}
    />
  )
}
