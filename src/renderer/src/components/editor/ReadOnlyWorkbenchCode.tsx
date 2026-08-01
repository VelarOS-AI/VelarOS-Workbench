import { type ReactElement, useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { buildReadOnlyCodeSearchHighlight } from '@renderer/models/editor/readOnlyCodeSearchHighlight'
import { resolveWorkbenchCodeMirrorLanguage } from '@renderer/models/editor/workbenchCodeMirrorLanguage'
import { getWorkbenchCodeMirrorTheme } from '@renderer/models/editor/workbenchCodeMirrorTheme'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'

export function ReadOnlyWorkbenchCode({
  content,
  path,
  workbenchTheme,
  highlightQuery = '',
}: {
  content: string
  path: Nullable<string>
  workbenchTheme: WorkbenchThemeId
  highlightQuery?: string
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const language = resolveWorkbenchCodeMirrorLanguage(path, '')
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          language.extension,
          getWorkbenchCodeMirrorTheme(workbenchTheme),
          buildReadOnlyCodeSearchHighlight(highlightQuery),
        ],
      }),
    })
    return () => view.destroy()
  }, [content, highlightQuery, path, workbenchTheme])

  return <div ref={hostRef} className={styles.editorHistoryCodeViewer} />
}
