import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretDownIcon,
  CaretUpIcon,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  useWorkbenchFileHistory,
  type WorkbenchFileHistoryMode,
} from '@workbench/hooks/useWorkbenchFileHistory'
import { useWorkbenchHistoryRecordContent } from '@workbench/hooks/useWorkbenchHistoryRecordContent'
import { useWorkbenchHistorySearchIndex } from '@workbench/hooks/useWorkbenchHistorySearchIndex'
import { useWorkbenchI18n } from '@workbench/i18n'
import { buildWorkbenchContentDiffRows } from '@workbench/models/git/workbenchGitDiffModel'
import type { WorkbenchThemeId } from '@workbench/models/settings/workbenchPreferences'

import { isEmpty, isNotNull, toNullable } from '@velaros-ai/core'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import styles from '../../styles/workbenchPageStyles'
import type { WorkbenchUnifiedDiffRowsHandle } from '../git/WorkbenchUnifiedDiffRows'
import { WorkbenchUnifiedDiffRows } from '../git/WorkbenchUnifiedDiffRows'

import { HistoryTimeline } from './HistoryTimeline'
import { ReadOnlyWorkbenchCode } from './ReadOnlyWorkbenchCode'

export type FileHistoryMode = WorkbenchFileHistoryMode

function fileNameFromPath(path: string): string {
  return path.split('/').findLast(Boolean) ?? path
}

export function FileHistoryView({
  projectRoot,
  path,
  workbenchTheme,
  initialMode,
  currentContent,
  onRestore,
  onClose,
}: {
  projectRoot: string
  path: string
  workbenchTheme: WorkbenchThemeId
  initialMode: FileHistoryMode
  currentContent: string
  onRestore: (content: string) => void
  onClose: () => void
}): ReactElement {
  const { t, locale } = useWorkbenchI18n()
  const [mode, setMode] = useState<FileHistoryMode>(initialMode)
  const [view, setView] = useState<'content' | 'diff'>('content')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<Nullable<string>>(null)
  const diffViewRef = useRef<WorkbenchUnifiedDiffRowsHandle>(null)
  const source = useWorkbenchFileHistory({
    mode,
    projectRoot,
    path,
    locale,
    enabled: true,
  })
  const selected = useWorkbenchHistoryRecordContent({
    loadContent: source.loadContent,
    selectedId,
  })
  const trimmedQuery = query.trim()
  const searchActive = !isEmpty(trimmedQuery)
  const searchIndex = useWorkbenchHistorySearchIndex({
    records: source.records,
    loadContent: source.loadContent,
    active: searchActive,
  })
  const filteredRecords = useMemo(() => {
    if (!searchActive) return source.records
    const needle = trimmedQuery.toLowerCase()
    return source.records.filter((record) =>
      (searchIndex.contents.get(record.id) ?? '').toLowerCase().includes(needle)
    )
  }, [searchActive, searchIndex.contents, source.records, trimmedQuery])

  useEffect(() => {
    if (searchActive && searchIndex.isIndexing) return
    if (selectedId && filteredRecords.some((record) => record.id === selectedId)) return
    setSelectedId(toNullable(filteredRecords[0]?.id))
  }, [filteredRecords, searchActive, searchIndex.isIndexing, selectedId])

  const diffRows = useMemo(
    () =>
      view === 'diff' && isNotNull(selected.content)
        ? buildWorkbenchContentDiffRows(path, selected.content, currentContent, { fullFile: true })
        : [],
    [currentContent, path, selected.content, view]
  )
  const changeCount = useMemo(() => {
    let count = 0
    for (let index = 0; index < diffRows.length; index += 1) {
      const row = diffRows[index]
      const previous = diffRows[index - 1]
      const changed = row.kind === 'addition' || row.kind === 'deletion'
      const previousChanged =
        previous?.kind === 'addition' || previous?.kind === 'deletion'
      if (changed && !previousChanged) count += 1
    }
    return count
  }, [diffRows])
  const selectedRecord = source.records.find((record) => record.id === selectedId)
  const canRestore = isNotNull(selected.content) && !selected.isLoading
  const showIndexing = searchActive && searchIndex.isIndexing
  const emptyMessage = searchActive
    ? t('workbench.fileHistorySearchNoMatch')
    : mode === 'local'
      ? t('workbench.localHistoryEmpty')
      : t('workbench.gitLogEmpty')
  const loadingMessage = showIndexing
    ? t('workbench.fileHistorySearching')
    : mode === 'local'
      ? t('workbench.localHistoryLoading')
      : t('workbench.gitLogLoading')

  return (
    <div className={styles.fileHistoryWindowRoot}>
      <header className={`${styles.editorGitHistoryHeader} ${styles.fileHistoryWindowHeader}`}>
        <div className={styles.editorHistoryHeaderMain}>
          <Text truncate className={styles.editorGitHistoryTitle}>
            {t('workbench.fileHistoryTitle', { file: fileNameFromPath(path) })}
          </Text>
          <SegmentedControl
            ariaLabel={t('workbench.fileHistoryTitle', { file: fileNameFromPath(path) })}
            value={mode}
            options={[
              { value: 'local', label: t('workbench.editorContextLocalHistory') },
              { value: 'git', label: t('workbench.editorContextGitHistory') },
            ]}
            onChange={setMode}
          />
        </div>
        <div className={styles.editorLocalHistoryActions}>
          <SegmentedControl
            ariaLabel={t('workbench.fileHistoryViewContent')}
            value={view}
            options={[
              { value: 'content', label: t('workbench.fileHistoryViewContent') },
              { value: 'diff', label: t('workbench.fileHistoryViewDiff') },
            ]}
            onChange={setView}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canRestore}
            onClick={() => {
              if (isNotNull(selected.content)) onRestore(selected.content)
            }}
          >
            <ClockCounterClockwiseIcon size={14} />
            <Text truncate>{t('workbench.localHistoryRestore')}</Text>
          </Button>
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={t('workbench.fileHistoryClose')}
            title={t('workbench.fileHistoryClose')}
            onClick={onClose}
          >
            <XIcon size={14} />
          </IconButton>
        </div>
      </header>
      <div className={styles.editorGitHistoryBody}>
        <div className={styles.editorHistoryLeft}>
          <div className={styles.editorHistorySearch}>
            <MagnifyingGlassIcon size={14} className={styles.editorHistorySearchIcon} />
            <Input
              size="sm"
              value={query}
              placeholder={t('workbench.fileHistorySearchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ScrollArea className={styles.editorGitHistoryList}>
            {source.isLoadingList || showIndexing ? (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                {loadingMessage}
              </Paragraph>
            ) : source.listError ? (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                {source.listError}
              </Paragraph>
            ) : isEmpty(filteredRecords) ? (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                {emptyMessage}
              </Paragraph>
            ) : (
              <HistoryTimeline
                items={filteredRecords}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            )}
          </ScrollArea>
        </div>
        <div className={styles.editorHistoryRight}>{renderRight()}</div>
      </div>
    </div>
  )

  function renderRight(): ReactElement {
    if (!selectedId) return (
        <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
          {mode === 'local' ? t('workbench.localHistoryEmpty') : t('workbench.gitCommitSelect')}
        </Paragraph>
      )
    if (selected.isLoading) return (
        <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
          {mode === 'local' ? t('workbench.localHistoryLoading') : t('workbench.gitDiffLoading')}
        </Paragraph>
      )
    if (selected.error) return (
        <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
          {selected.error}
        </Paragraph>
      )
    if (view === 'diff') {
      if (isEmpty(diffRows)) return (
          <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
            {t('workbench.fileHistoryNoDiff')}
          </Paragraph>
        )
      return (
        <div className={styles.editorHistoryDiffPane}>
          <div className={styles.editorHistoryDiffToolbar}>
            <Text truncate className={styles.editorHistoryDiffLabel}>
              {selectedRecord?.title ?? ''}
            </Text>
            <span className={styles.editorHistoryDiffArrow} aria-hidden>
              →
            </span>
            <Text truncate className={styles.editorHistoryDiffLabel}>
              {t('workbench.fileHistoryDiffCurrent')}
            </Text>
            <span className={styles.editorHistoryDiffSpacer} />
            <span className={styles.editorHistoryDiffCount}>
              {t('workbench.fileHistoryDiffCount', { count: changeCount })}
            </span>
            <IconButton
              variant="ghost"
              size="icon-sm"
              disabled={!changeCount}
              label={t('workbench.fileHistoryDiffPrev')}
              title={t('workbench.fileHistoryDiffPrev')}
              onClick={() => diffViewRef.current?.goToChange(-1)}
            >
              <CaretUpIcon size={14} />
            </IconButton>
            <IconButton
              variant="ghost"
              size="icon-sm"
              disabled={!changeCount}
              label={t('workbench.fileHistoryDiffNext')}
              title={t('workbench.fileHistoryDiffNext')}
              onClick={() => diffViewRef.current?.goToChange(1)}
            >
              <CaretDownIcon size={14} />
            </IconButton>
          </div>
          <WorkbenchUnifiedDiffRows
            ref={diffViewRef}
            rows={diffRows}
            path={path}
            workbenchTheme={workbenchTheme}
          />
        </div>
      )
    }
    return (
      <ReadOnlyWorkbenchCode
        content={selected.content ?? ''}
        path={path}
        workbenchTheme={workbenchTheme}
        highlightQuery={searchActive ? trimmedQuery : ''}
      />
    )
  }
}
