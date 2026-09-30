import {
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useState,
} from 'react'
import {
  ArrowsLeftRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  FolderIcon,
  PlayCircleIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import { getWorkbenchFilePresentationVariant } from '@renderer/models/files/workbenchFilePresentation'
import {
  formatWorkbenchProjectSearchCount,
  type WorkbenchProjectSearchFile,
  type WorkbenchProjectSearchRow,
} from '@renderer/models/files/workbenchProjectSearchModel'
import { isWorkbenchTestFilePath } from '@renderer/models/files/workbenchTestFile'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'

import { StyleUtils } from '@velaros-ai/ui'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type { WorkbenchContentSearchMatchResult, WorkbenchDirectoryEntry } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchCodeSnippet } from '../editor/WorkbenchCodeSnippet'

import { WorkbenchFileTypeIcon } from './WorkbenchFileTypeIcon'

const cx = StyleUtils.bindCx(styles)

/** 视野上下各多渲染这么多行，滚动时不露白。 */
const OverscanRows = 8

interface FileSearchResultsProps {
  rows: readonly WorkbenchProjectSearchRow[]
  /** 每一行的高度（跟文件树的行高走）。 */
  rowHeight: number
  /** 结果所在的滚动容器：只渲染视野里的那些行。 */
  scrollRef: RefObject<Nullable<HTMLDivElement>>
  /** 查找框里上下键挑中的那一行。 */
  activeRowKey: Nullable<string>
  gitDecorations: WorkbenchGitDecorationMap
  selectedEntryPath: Nullable<string>
  /**
   * 替换行展开着时给出：一处匹配（传入匹配本身的文字）要换成什么，行里据此预览，行尾给出替换按钮。
   * 没展开为 null。
   */
  previewReplacement: Nullable<(matchedText: string) => string>
  /** 替换按钮点不了：结果还在搜、条件变了还没重搜完，或者正在替换。 */
  replaceDisabled: boolean
  onActivateRow: (key: string) => void
  onToggleEntries: () => void
  onToggleFile: (path: string) => void
  onOpenEntry: (entry: WorkbenchDirectoryEntry) => void
  onOpenMatch: (file: WorkbenchProjectSearchFile, match: WorkbenchContentSearchMatchResult) => void
  onReplaceFile: (file: WorkbenchProjectSearchFile) => void
  onReplaceMatch: (file: WorkbenchProjectSearchFile, match: WorkbenchContentSearchMatchResult) => void
  onContextMenuEntry: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
}

/**
 * 项目搜索的结果：最上面是按文件名找到的条目，下面每个文件一行（可收起、带匹配数），文件下面是每一处匹配。
 * 结果可能上千行，只渲染视野里的那些（每行一样高）。
 */
export function FileSearchResults({
  rows,
  rowHeight,
  scrollRef,
  activeRowKey,
  gitDecorations,
  selectedEntryPath,
  previewReplacement,
  replaceDisabled,
  onActivateRow,
  onToggleEntries,
  onToggleFile,
  onOpenEntry,
  onOpenMatch,
  onReplaceFile,
  onReplaceMatch,
  onContextMenuEntry,
}: FileSearchResultsProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const { start, end } = useVisibleRowRange(scrollRef, rows.length, rowHeight)

  function renderRow(row: WorkbenchProjectSearchRow): ReactNode {
    switch (row.kind) {
      case 'entries':
        return (
          <>
            <Disclosure collapsed={row.collapsed} />
            <Text truncate className={styles.projectSearchGroupTitle}>
              {t('workbench.projectSearchFileNames')}
            </Text>
            <span className={styles.projectSearchCount}>{row.count}</span>
          </>
        )
      case 'entry':
        return (
          <>
            {row.entry.type === 'directory' ? (
              <span className={styles.treeFolderIcon}>
                <FolderIcon size={15} weight="duotone" />
              </span>
            ) : (
              <FileIcon path={row.entry.path} name={row.entry.name} />
            )}
            <Text truncate className={styles.projectSearchName}>
              {row.entry.name}
            </Text>
            <Text truncate tone="caption" className={styles.projectSearchDirectory}>
              {row.entry.path}
            </Text>
          </>
        )
      case 'file':
        return (
          <>
            <Disclosure collapsed={row.collapsed} />
            <FileIcon path={row.file.path} name={row.file.fileName} />
            <Text truncate className={styles.projectSearchName}>
              {row.file.fileName}
            </Text>
            <Text truncate tone="caption" className={styles.projectSearchDirectory}>
              {row.file.directory}
            </Text>
            {previewReplacement && (
              <RowAction
                label={t('workbench.projectSearchReplaceFile')}
                disabled={replaceDisabled}
                onClick={() => onReplaceFile(row.file)}
              />
            )}
            <span className={styles.projectSearchCount}>{row.file.matchCount}</span>
          </>
        )
      case 'match':
        return (
          <>
            <span className={styles.projectSearchLineNumber}>{row.match.line}</span>
            <WorkbenchCodeSnippet
              path={row.file.path}
              text={row.match.excerpt}
              match={{ start: row.match.excerptMatchStart, end: row.match.excerptMatchEnd }}
              replacement={
                previewReplacement
                  ? previewReplacement(
                      row.match.excerpt.slice(row.match.excerptMatchStart, row.match.excerptMatchEnd)
                    )
                  : undefined
              }
              className={styles.projectSearchExcerpt}
            />
            {previewReplacement && (
              <RowAction
                label={t('workbench.findReplace')}
                disabled={replaceDisabled}
                onClick={() => onReplaceMatch(row.file, row.match)}
              />
            )}
          </>
        )
      case 'more':
        return (
          <Text truncate tone="caption" className={styles.projectSearchMore}>
            {t('workbench.projectSearchMoreMatches', {
              matches: formatWorkbenchProjectSearchCount(t, 'match', row.hidden),
            })}
          </Text>
        )
    }
  }

  function handleClick(row: WorkbenchProjectSearchRow): void {
    switch (row.kind) {
      case 'entries':
        onToggleEntries()
        return
      case 'entry':
        onOpenEntry(row.entry)
        return
      case 'file':
        onToggleFile(row.file.path)
        return
      case 'match':
        onOpenMatch(row.file, row.match)
    }
  }

  return (
    <div
      role="tree"
      aria-label={t('workbench.projectSearchResults')}
      className={styles.projectSearchList}
      style={{ height: rows.length * rowHeight }}
    >
      {rows.slice(start, end).map((row, offset) => {
        const path = row.kind === 'entry' ? row.entry.path : row.kind === 'file' ? row.file.path : null
        const collapsed = row.kind === 'entries' || row.kind === 'file' ? row.collapsed : undefined
        return (
          <div
            key={row.key}
            role="treeitem"
            aria-level={row.kind === 'entries' || row.kind === 'file' ? 1 : 2}
            aria-expanded={collapsed === undefined ? undefined : !collapsed}
            aria-selected={activeRowKey === row.key}
            className={cx(
              'projectSearchRow',
              activeRowKey === row.key && 'projectSearchRowActive',
              row.kind === 'entry' && selectedEntryPath === row.entry.path && 'projectSearchRowSelected'
            )}
            style={
              {
                height: rowHeight,
                transform: `translateY(${(start + offset) * rowHeight}px)`,
              } as CSSProperties
            }
            data-kind={row.kind}
            data-search-row
            data-git-tone={path ? gitDecorations.get(path)?.tone : undefined}
            title={row.kind === 'match' ? `${row.file.path}:${row.match.line}:${row.match.column}` : undefined}
            onClick={() => handleClick(row)}
            onMouseEnter={
              row.kind === 'entry' || row.kind === 'match' ? () => onActivateRow(row.key) : undefined
            }
            onContextMenu={row.kind === 'entry' ? (event) => onContextMenuEntry(row.entry, event) : undefined}
          >
            {renderRow(row)}
          </div>
        )
      })}
    </div>
  )
}

function Disclosure({ collapsed }: { collapsed: boolean }): ReactElement {
  return (
    <span className={styles.projectSearchDisclosure} aria-hidden="true">
      {collapsed ? <CaretRightIcon size={12} /> : <CaretDownIcon size={12} />}
    </span>
  )
}

function FileIcon({ path, name }: { path: string; name: string }): ReactElement {
  const isTestFile = isWorkbenchTestFilePath(path)
  return (
    <span
      className={styles.treeFileIcon}
      data-kind={getWorkbenchFilePresentationVariant({ fileName: name })}
      data-test-file={isTestFile || undefined}
    >
      <WorkbenchFileTypeIcon fileName={name} size={15} />
      {isTestFile && (
        <PlayCircleIcon size={8} weight="fill" className={styles.treeTestFileBadge} aria-hidden="true" />
      )}
    </span>
  )
}

/** 行尾的替换按钮：指针停在行上时才显示，点它不触发行本身的点击。 */
function RowAction({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}): ReactElement {
  return (
    <IconButton
      variant="ghost"
      size={20}
      label={label}
      disabled={disabled}
      className={styles.projectSearchRowAction}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <ArrowsLeftRightIcon size={13} />
    </IconButton>
  )
}

/** 滚动容器视野里是第几行到第几行（前后各多带几行）。 */
function useVisibleRowRange(
  scrollRef: RefObject<Nullable<HTMLDivElement>>,
  rowCount: number,
  rowHeight: number
): { start: number; end: number } {
  const [viewport, setViewport] = useState({ top: 0, height: 0 })

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined

    const update = (): void => {
      const top = element.scrollTop
      const height = element.clientHeight
      setViewport((current) =>
        current.top === top && current.height === height ? current : { top, height }
      )
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollRef])

  const first = Math.floor(viewport.top / rowHeight)
  const visible = Math.ceil(viewport.height / rowHeight) + 1
  return {
    start: Math.max(0, first - OverscanRows),
    end: Math.min(rowCount, first + visible + OverscanRows),
  }
}
