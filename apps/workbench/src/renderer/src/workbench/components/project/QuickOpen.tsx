import { type ReactElement, useEffect, useRef, useState } from 'react'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { useWorkbenchI18n } from '@velaros-ai/workbench/i18n'
import type { WorkbenchProject } from '@velaros-ai/workbench/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@velaros-ai/workbench/types/workbenchTypes'

import { useWorkbenchContentSearchController } from '../../hooks/useWorkbenchContentSearchController'
import styles from '../../styles/workbenchPageStyles'
import { useTimerScope } from '../../support/genericHooks'

const QUICK_OPEN_CONTENT_SEARCH_LIMIT = 60

interface QuickOpenProps {
  isOpen: boolean
  activeProject: Nullable<WorkbenchProject>
  openTabs: WorkbenchOpenEditorTab[]
  onClose: () => void
  onOpenLocation: (path: string, line: number, column: number) => void
}

export function QuickOpen({
  isOpen,
  activeProject,
  openTabs,
  onClose,
  onOpenLocation,
}: QuickOpenProps): Nullable<ReactElement> {
  const { t } = useWorkbenchI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const timers = useTimerScope('QuickOpen')
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl'
  const normalizedQuery = query.trim()
  const { contentSearchMatches, isSearchingContent } = useWorkbenchContentSearchController({
    activeProject,
    openTabs,
    query,
    enabled: isOpen,
    limit: QUICK_OPEN_CONTENT_SEARCH_LIMIT,
  })

  useEffect(() => {
    if (!isOpen) return

    setQuery('')
    setActiveIndex(0)
    const frame = timers.nextFrame(() => inputRef.current?.focus(), {
      label: 'workbench.quickOpen.focus',
    })
    return () => {
      frame.cancel()
    }
  }, [isOpen, timers])

  useEffect(() => {
    if (activeIndex >= contentSearchMatches.length) {
      setActiveIndex(Math.max(0, contentSearchMatches.length - 1))
    }
  }, [activeIndex, contentSearchMatches.length])

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-quick-open-index="${activeIndex}"]`
    )
    row?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!isOpen) return null

  function selectMatch(path: string, line: number, column: number): void {
    onClose()
    onOpenLocation(path, line, column)
  }

  function emptyMessage(): string {
    if (!normalizedQuery) return t('workbench.quickOpenContentHint')

    if (isSearchingContent) return t('workbench.searching')

    return t('workbench.quickOpenEmpty')
  }

  return (
    <div className={styles.quickOpenOverlay} onMouseDown={onClose}>
      <section
        className={styles.quickOpenDialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.quickOpenTitle')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.quickOpenHeader}>
          <div>
            <Title level={5}>{t('workbench.quickOpenTitle')}</Title>
            <Text tone="caption" truncate>
              {t('workbench.globalSearchFiles')}
            </Text>
          </div>
          <kbd>{shortcutModifier} P</kbd>
        </header>
        <div className={styles.quickOpenInputRow}>
          <MagnifyingGlassIcon size={16} />
          <Input
            ref={inputRef}
            variant="ghost"
            size="sm"
            className={styles.quickOpenInput}
            value={query}
            placeholder={t('workbench.quickOpenPlaceholder')}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
                return
              }

              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) =>
                  contentSearchMatches.length ? (index + 1) % contentSearchMatches.length : 0
                )
                return
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) =>
                  contentSearchMatches.length
                    ? (index + contentSearchMatches.length - 1) % contentSearchMatches.length
                    : 0
                )
                return
              }

              if (event.key === 'Home') {
                event.preventDefault()
                setActiveIndex(0)
                return
              }

              if (event.key === 'End') {
                event.preventDefault()
                setActiveIndex(Math.max(0, contentSearchMatches.length - 1))
                return
              }

              if (event.key === 'Enter') {
                event.preventDefault()
                const match = contentSearchMatches[activeIndex]
                if (match) {
                  selectMatch(match.path, match.line, match.column)
                }
              }
            }}
          />
        </div>

        <div ref={listRef} className={styles.quickOpenList} role="listbox">
          {contentSearchMatches.length ? (
            contentSearchMatches.map((match, index) => (
              <Button
                key={match.id}
                variant="ghost"
                size="block"
                className={styles.quickOpenItem}
                data-active={index === activeIndex}
                data-open={match.isOpen}
                data-quick-open-index={index}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectMatch(match.path, match.line, match.column)}
              >
                <span className={styles.treeFileIcon}>
                  <FileTypeIcon fileName={match.fileName} size={15} />
                </span>
                <span className={styles.quickOpenItemCopy}>
                  <Text truncate className={styles.quickOpenItemName}>
                    {match.fileName}
                  </Text>
                  <Text truncate tone="caption" className={styles.quickOpenItemPath}>
                    {match.path}:{match.line}
                  </Text>
                  <Text truncate className={styles.searchContentExcerpt}>
                    {match.excerpt}
                  </Text>
                </span>
                {match.isOpen ? (
                  <Text truncate tone="caption" className={styles.quickOpenItemMeta}>
                    {t('workbench.quickOpenAlreadyOpen')}
                  </Text>
                ) : (
                  <Text truncate tone="caption" className={styles.quickOpenItemMeta}>
                    {match.line}
                  </Text>
                )}
              </Button>
            ))
          ) : (
            <Paragraph tone="muted" spacing="none" className={styles.quickOpenEmpty}>
              {emptyMessage()}
            </Paragraph>
          )}
        </div>
      </section>
    </div>
  )
}
