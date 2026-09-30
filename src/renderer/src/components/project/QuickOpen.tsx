import {
  type ReactElement,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'
import { getWorkbenchEditorLineCount } from '@renderer/models/editor/workbenchEditorModel'
import type { WorkbenchContentSearchMatch } from '@renderer/models/files/workbenchContentSearchModel'
import { getWorkbenchFilePresentationVariant } from '@renderer/models/files/workbenchFilePresentation'
import {
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  formatWorkbenchShortcutHint,
  type WorkbenchKeyboardShortcutMap,
} from '@renderer/models/layout/workbenchKeyboardShortcuts'
import {
  buildWorkbenchQuickOpenFileItems,
  buildWorkbenchQuickOpenRecentItems,
  parseWorkbenchQuickOpenQuery,
  type WorkbenchQuickOpenFileItem,
  type WorkbenchQuickOpenQuery,
} from '@renderer/models/layout/workbenchQuickOpenModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'

import { useWorkbenchContentSearchController } from '../../hooks/useWorkbenchContentSearchController'
import { useWorkbenchProjectFileList } from '../../hooks/useWorkbenchProjectFileList'
import styles from '../../styles/workbenchPageStyles'
import { useTimerScope } from '../../support/genericHooks'
import { WorkbenchCodeSnippet } from '../editor/WorkbenchCodeSnippet'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

const QUICK_OPEN_CONTENT_SEARCH_LIMIT = 60
const QUICK_OPEN_FILE_RESULT_LIMIT = 50
/** 内容搜索至少要几个字符：一个字母几乎每行都中，只会拖慢结果。 */
const QUICK_OPEN_CONTENT_SEARCH_MIN_LENGTH = 2

export interface WorkbenchQuickOpenPosition {
  line: number
  column?: number
}

interface QuickOpenProps {
  isOpen: boolean
  activeProject: Nullable<WorkbenchProject>
  openTabs: WorkbenchOpenEditorTab[]
  /** 编辑器的当前文件：最近打开的列表把它放到最后，`:行号` 在它里面跳。 */
  activeFilePath: Nullable<string>
  /** 当前文件的正文（`:行号` 按它的行数收住）。 */
  activeFileContent: string
  /** 最近打开过的文件，最近的在前。 */
  recentFilePaths: readonly string[]
  /** 当前快捷键设置：标题栏上的快捷键提示按它现算。 */
  keymap?: WorkbenchKeyboardShortcutMap
  onClose: () => void
  /** 打开文件；给了位置就跳到那一行（列）。 */
  onOpenFile: (path: string, position?: WorkbenchQuickOpenPosition) => void
}

type QuickOpenRow =
  | {
      kind: 'file'
      key: string
      item: WorkbenchQuickOpenFileItem
      /** 输入里写了 `:行[:列]` 时要跳到的位置。 */
      position?: WorkbenchQuickOpenPosition
    }
  | { kind: 'content'; key: string; match: WorkbenchContentSearchMatch }
  | { kind: 'line'; key: string; path: string; position: Required<WorkbenchQuickOpenPosition> }

interface QuickOpenSection {
  key: string
  title?: string
  note?: string
  rows: QuickOpenRow[]
}

/** 名字、路径里命中输入的字符用 `<mark>` 标出来，连着的并成一段。 */
function renderMatchedText(text: string, matches: readonly number[]): ReactNode {
  if (matches.length === 0) return text

  const matched = new Set(matches)
  const parts: ReactNode[] = []
  let start = 0
  while (start < text.length) {
    const isMatch = matched.has(start)
    let end = start + 1
    while (end < text.length && matched.has(end) === isMatch) end += 1

    const segment = text.slice(start, end)
    parts.push(
      isMatch ? (
        <mark key={start} className={styles.quickOpenMatch}>
          {segment}
        </mark>
      ) : (
        segment
      )
    )
    start = end
  }
  return parts
}

function formatPosition(position: WorkbenchQuickOpenPosition): string {
  return position.column ? `${position.line}:${position.column}` : String(position.line)
}

function FileIcon({ fileName }: { fileName: string }): ReactElement {
  return (
    <span
      className={styles.treeFileIcon}
      data-kind={getWorkbenchFilePresentationVariant({ fileName })}
    >
      <WorkbenchFileTypeIcon fileName={fileName} size={15} />
    </span>
  )
}

export function QuickOpen({
  isOpen,
  activeProject,
  openTabs,
  activeFilePath,
  activeFileContent,
  recentFilePaths,
  keymap = DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  onClose,
  onOpenFile,
}: QuickOpenProps): Nullable<ReactElement> {
  const { t } = useWorkbenchI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 打开前焦点在哪：关掉（不去别处）时还回去。 */
  const returnFocusRef = useRef<Nullable<HTMLElement>>(null)
  const timers = useTimerScope('QuickOpen')
  const idPrefix = useId()
  const listboxId = `${idPrefix}-results`
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // 结果按「延后一步」的输入算：大项目里给几万个文件打分时，输入框照样跟手。
  const resultQuery = useDeferredValue(query)
  const parsedQuery = useMemo(() => parseWorkbenchQuickOpenQuery(resultQuery), [resultQuery])
  const openTabPaths = useMemo(() => openTabs.map((tab) => tab.path), [openTabs])
  const projectFiles = useWorkbenchProjectFileList({
    projectRoot: activeProject?.rootPath ?? null,
    active: isOpen,
  })
  // 内容结果排在文件后面：够长的文件名输入才顺带搜内容（有防抖），跳行模式不搜。
  const contentQuery = resultQuery.trim()
  const contentSearchEnabled =
    isOpen &&
    parsedQuery.mode === 'files' &&
    contentQuery.length >= QUICK_OPEN_CONTENT_SEARCH_MIN_LENGTH
  const { contentSearchMatches, isSearchingContent } = useWorkbenchContentSearchController({
    activeProject,
    openTabs,
    query: contentQuery,
    enabled: contentSearchEnabled,
    limit: QUICK_OPEN_CONTENT_SEARCH_LIMIT,
  })
  const activeFileLineCount = useMemo(
    () =>
      isOpen && parsedQuery.mode === 'line' ? getWorkbenchEditorLineCount(activeFileContent) : 0,
    [activeFileContent, isOpen, parsedQuery.mode]
  )

  /** 按一次输入排出结果分组；内容结果只有屏幕上那次输入才有（它是异步搜出来的）。 */
  function buildSections(
    parsed: WorkbenchQuickOpenQuery,
    contentMatches: readonly WorkbenchContentSearchMatch[]
  ): QuickOpenSection[] {
    if (parsed.mode === 'line') {
      if (!activeFilePath || !parsed.line) return []

      const lineCount = getWorkbenchEditorLineCount(activeFileContent)
      const position = { line: Math.min(parsed.line, lineCount), column: parsed.column ?? 1 }
      return [
        {
          key: 'line',
          rows: [{ kind: 'line', key: 'line', path: activeFilePath, position }],
        },
      ]
    }
    if (parsed.mode !== 'files') return []

    const sections: QuickOpenSection[] = []
    if (!parsed.text) {
      const recentItems = buildWorkbenchQuickOpenRecentItems({
        recentPaths: recentFilePaths,
        openTabPaths,
        activePath: activeFilePath,
        files: projectFiles.truncated ? null : projectFiles.files,
      })
      if (recentItems.length > 0)
        sections.push({
          key: 'recent',
          title: t('workbench.quickOpenRecentFiles'),
          rows: recentItems.map((item) => ({ kind: 'file', key: `file:${item.path}`, item })),
        })
      return sections
    }

    const position = parsed.line
      ? { line: parsed.line, column: parsed.column ?? undefined }
      : undefined
    const fileItems = buildWorkbenchQuickOpenFileItems({
      files: projectFiles.files ?? [],
      openTabPaths,
      recentPaths: recentFilePaths,
      activePath: activeFilePath,
      query: parsed.text,
      limit: QUICK_OPEN_FILE_RESULT_LIMIT,
    })
    if (fileItems.length > 0)
      sections.push({
        key: 'files',
        title: t('workbench.quickOpenFileResults'),
        note: projectFiles.truncated
          ? t('workbench.quickOpenFilesTruncated', { count: projectFiles.files?.length ?? 0 })
          : undefined,
        rows: fileItems.map((item) => ({ kind: 'file', key: `file:${item.path}`, item, position })),
      })
    if (contentMatches.length > 0)
      sections.push({
        key: 'content',
        title: t('workbench.quickOpenContentResults'),
        rows: contentMatches.map((match) => ({ kind: 'content', key: `content:${match.id}`, match })),
      })
    return sections
  }

  const sections = useMemo(
    () => (isOpen ? buildSections(parsedQuery, contentSearchEnabled ? contentSearchMatches : []) : []),
    // buildSections 读的都在下面：输入、文件清单、最近打开、标签、当前文件与内容结果（函数本身每次渲染都新建）。
    [
      activeFileContent,
      activeFilePath,
      contentSearchEnabled,
      contentSearchMatches,
      isOpen,
      openTabPaths,
      parsedQuery,
      projectFiles.files,
      projectFiles.truncated,
      recentFilePaths,
      t,
    ]
  )
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections])
  const selectedIndex = Math.min(activeIndex, Math.max(0, rows.length - 1))

  useEffect(() => {
    if (!isOpen) return

    const previousFocus = document.activeElement
    returnFocusRef.current =
      previousFocus instanceof HTMLElement && previousFocus !== document.body ? previousFocus : null
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
    const row = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-quick-open-index="${selectedIndex}"]`
    )
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, rows])

  if (!isOpen) return null

  /** 关掉；没去别处（没打开文件）时把焦点还给打开前的地方。 */
  function close(returnFocus: boolean): void {
    onClose()
    const target = returnFocusRef.current
    returnFocusRef.current = null
    if (returnFocus && target?.isConnected) target.focus()
  }

  function openRow(row: QuickOpenRow): void {
    close(false)
    switch (row.kind) {
      case 'file': {
        onOpenFile(row.item.path, row.position)
        return
      }
      case 'content': {
        onOpenFile(row.match.path, { line: row.match.line, column: row.match.column })
        return
      }
      case 'line': {
        onOpenFile(row.path, row.position)
      }
    }
  }

  /** 回车：结果还停在上一步的输入上（刚粘贴、敲得快）时按现在的输入现算，打开排第一的那项。 */
  function openSelectedRow(): void {
    const row =
      query === resultQuery
        ? rows[selectedIndex]
        : buildSections(parseWorkbenchQuickOpenQuery(query), []).flatMap(
            (section) => section.rows
          )[0]
    if (row) openRow(row)
  }

  function moveActiveIndex(offset: number): void {
    if (rows.length === 0) return
    setActiveIndex((selectedIndex + offset + rows.length) % rows.length)
  }

  function emptyMessage(): string {
    if (parsedQuery.mode === 'line') {
      if (!activeFilePath) return t('workbench.quickOpenGoToLineNoFile')

      return t('workbench.quickOpenGoToLineHint', { count: activeFileLineCount })
    }
    if (!parsedQuery.text) return t('workbench.quickOpenHint')
    if (!projectFiles.files && projectFiles.isLoading) return t('workbench.quickOpenFilesLoading')
    if (contentSearchEnabled && isSearchingContent) return t('workbench.searching')

    return t('workbench.quickOpenEmpty')
  }

  function renderRowContent(row: QuickOpenRow): ReactNode {
    switch (row.kind) {
      case 'file': {
        const { item, position } = row
        return (
          <>
            <FileIcon fileName={item.name} />
            <span className={styles.quickOpenItemCopy}>
              <span className={styles.quickOpenItemHeading}>
                <Text truncate className={styles.quickOpenItemName}>
                  {renderMatchedText(item.name, item.nameMatches)}
                </Text>
                <Text truncate tone="caption" className={styles.quickOpenItemPath}>
                  {renderMatchedText(item.directory, item.directoryMatches)}
                </Text>
                {position && (
                  <Text tone="caption" className={styles.quickOpenItemMeta}>
                    {formatPosition(position)}
                  </Text>
                )}
                {item.isOpen && (
                  <Text tone="caption" className={styles.quickOpenItemMeta}>
                    {t('workbench.quickOpenAlreadyOpen')}
                  </Text>
                )}
              </span>
            </span>
          </>
        )
      }
      case 'content': {
        const { match } = row
        return (
          <>
            <FileIcon fileName={match.fileName} />
            <span className={styles.quickOpenItemCopy}>
              <span className={styles.quickOpenItemHeading}>
                <Text truncate className={styles.quickOpenItemName}>
                  {match.fileName}
                </Text>
                <Text truncate tone="caption" className={styles.quickOpenItemPath}>
                  {match.path}:{match.line}
                </Text>
                {match.isOpen && (
                  <Text tone="caption" className={styles.quickOpenItemMeta}>
                    {t('workbench.quickOpenAlreadyOpen')}
                  </Text>
                )}
              </span>
              <WorkbenchCodeSnippet
                path={match.path}
                text={match.excerpt}
                query={contentQuery}
                className={styles.searchContentExcerpt}
              />
            </span>
          </>
        )
      }
      case 'line': {
        const { path, position } = row
        return (
          <>
            <FileIcon fileName={path.slice(path.lastIndexOf('/') + 1)} />
            <span className={styles.quickOpenItemCopy}>
              <span className={styles.quickOpenItemHeading}>
                <Text truncate className={styles.quickOpenItemName}>
                  {parsedQuery.column
                    ? t('workbench.quickOpenGoToLineColumn', position)
                    : t('workbench.quickOpenGoToLine', { line: position.line })}
                </Text>
                <Text truncate tone="caption" className={styles.quickOpenItemPath}>
                  {path}
                </Text>
              </span>
            </span>
          </>
        )
      }
    }
  }

  let rowIndex = 0
  const optionId = (index: number): string => `${idPrefix}-option-${index}`

  return (
    <div className={styles.quickOpenOverlay} onMouseDown={() => close(true)}>
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
          <kbd>{formatWorkbenchShortcutHint(keymap['quick-open'])}</kbd>
        </header>
        <div className={styles.quickOpenInputRow}>
          <div className={styles.quickOpenInput}>
            <SearchField
              ref={inputRef}
              size="sm"
              value={query}
              placeholder={t('workbench.quickOpenPlaceholder')}
              role="combobox"
              aria-expanded
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={rows.length ? optionId(selectedIndex) : undefined}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  close(true)
                  return
                }

                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  moveActiveIndex(1)
                  return
                }

                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  moveActiveIndex(-1)
                  return
                }

                if (event.key === 'Home') {
                  event.preventDefault()
                  setActiveIndex(0)
                  return
                }

                if (event.key === 'End') {
                  event.preventDefault()
                  setActiveIndex(Math.max(0, rows.length - 1))
                  return
                }

                if (event.key === 'Enter') {
                  event.preventDefault()
                  openSelectedRow()
                }
              }}
            />
          </div>
        </div>

        <div
          ref={listRef}
          id={listboxId}
          className={styles.quickOpenList}
          role="listbox"
          aria-label={t('workbench.quickOpenTitle')}
        >
          {rows.length ? (
            sections.map((section) => {
              const titleId = `${idPrefix}-${section.key}-title`
              return (
                <div
                  key={section.key}
                  className={styles.quickOpenSection}
                  role="group"
                  aria-labelledby={section.title ? titleId : undefined}
                >
                  {section.title && (
                    <div id={titleId} className={styles.quickOpenSectionTitle} role="presentation">
                      <span>{section.title}</span>
                      {section.note && (
                        <span className={styles.quickOpenSectionNote}>{section.note}</span>
                      )}
                    </div>
                  )}
                  {section.rows.map((row) => {
                    const index = rowIndex
                    rowIndex += 1
                    return (
                      <Button
                        key={row.key}
                        id={optionId(index)}
                        variant="ghost"
                        size="block"
                        tabIndex={-1}
                        className={styles.quickOpenItem}
                        data-active={index === selectedIndex}
                        data-open={
                          row.kind === 'file'
                            ? row.item.isOpen
                            : row.kind === 'content'
                              ? row.match.isOpen
                              : undefined
                        }
                        data-quick-open-index={index}
                        role="option"
                        aria-selected={index === selectedIndex}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => openRow(row)}
                      >
                        {renderRowContent(row)}
                      </Button>
                    )
                  })}
                </div>
              )
            })
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
