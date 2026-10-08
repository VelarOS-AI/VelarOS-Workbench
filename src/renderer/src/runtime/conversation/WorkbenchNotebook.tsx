import { type ReactElement, useEffect, useState } from 'react'
import { BookOpenTextIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import { AppError } from '@velaros-ai/core/error'
import { Popover, PopoverAnchor, PopoverContent } from '@velaros-ai/ui/primitives/overlays/Popover'
import type { RuntimeNoteContent } from '@velaros-ai/velaros'

import { readWorkbenchNotebook } from './readWorkbenchNotebook'

import styles from '../../styles/WorkbenchNotebook.module.css'

/** 当前会话工作笔记，打开时读取，回合推进时即时刷新。 */
export function WorkbenchNotebook({
  projectRoot,
  sessionId,
}: {
  projectRoot: string
  sessionId: string
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<readonly RuntimeNoteContent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Nullable<string>>(null)
  useEffect(() => {
    setNotes([])
    setError(null)
    setLoading(open)
    if (!open) return
    const scope = new AbortController()
    let current: readonly RuntimeNoteContent[] = []
    let reading = false
    let dirty = false
    const load = async (): Promise<void> => {
      dirty = true
      if (reading) return
      reading = true
      setLoading(true)
      try {
        do {
          dirty = false
          current = await readWorkbenchNotebook(
            window.velarosWorkbenchConversation,
            { projectRoot, sessionId },
            current,
            scope.signal
          )
          scope.signal.throwIfAborted()
          setNotes(current)
          setError(null)
        } while (dirty && !scope.signal.aborted)
      } catch (failure) {
        if (!scope.signal.aborted) setError(AppError.getMessage(failure))
      } finally {
        reading = false
        if (!scope.signal.aborted) {
          setLoading(false)
          if (dirty) void load()
        }
      }
    }
    const unsubscribe = window.velarosWorkbenchConversation.onNotesChanged((ref) => {
      if (ref.sessionId === sessionId && ref.projectRoot === projectRoot) void load()
    })
    void load()
    return () => {
      scope.abort()
      unsubscribe()
    }
  }, [sessionId, projectRoot, open])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className={styles.trigger}
          title={t('workbench.notebookTitle')}
          aria-label={t('workbench.notebookTitle')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <BookOpenTextIcon size={16} />
        </button>
      </PopoverAnchor>
      <PopoverContent align="end" side="bottom" sideOffset={4} widthStrategy="content" className={styles.popover}>
        <section
          className={styles.panel}
          aria-label={t('workbench.notebookTitle')}
          aria-description={t('workbench.notebookDescription')}
        >
          <strong>{t('workbench.notebookTitle')}</strong>
          <div className={styles.list} aria-busy={loading}>
            {loading && <p role="status">{t('workbench.notebookLoading')}</p>}
            {!loading && !error && notes.length === 0 && <p>{t('workbench.notebookEmpty')}</p>}
            {notes.map(({ entry, text }) => (
              <article key={entry.key} className={styles.item}>
                <header>
                  <strong>{entry.title}</strong>
                  <span>
                    {t(entry.resident ? 'workbench.notebookActive' : 'workbench.notebookArchived')}
                  </span>
                </header>
                <p>{text}</p>
              </article>
            ))}
          </div>
          {error && <p role="alert">{error}</p>}
        </section>
      </PopoverContent>
    </Popover>
  )
}
