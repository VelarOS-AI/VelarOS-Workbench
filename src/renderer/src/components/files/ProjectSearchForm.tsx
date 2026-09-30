import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
} from 'react'
import {
  ArrowsClockwiseIcon,
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  CaretRightIcon,
  DotsThreeIcon,
} from '@phosphor-icons/react'
import type { WorkbenchProjectSearchModel } from '@renderer/hooks/useWorkbenchProjectSearchController'
import { WorkbenchProjectSearchLimit } from '@renderer/hooks/useWorkbenchProjectSearchController'
import { useWorkbenchI18n } from '@renderer/i18n'
import { formatWorkbenchProjectSearchCount } from '@renderer/models/files/workbenchProjectSearchModel'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'

import type { WorkbenchTextSearchOptions } from '@shared/workbenchTextSearch'

import styles from '../../styles/workbenchPageStyles'

const isApplePlatform = /Mac|iPhone|iPad/u.test(navigator.platform)

/**
 * 开关项的快捷键，与编辑器的查找栏一致：macOS 上 ⌥⌘C / ⌥⌘W / ⌥⌘R，其它平台 Alt+C / W / R。按物理键认：
 * macOS 上单按 ⌥C 是在打 ç，不能拦。
 */
const OptionShortcutCodes: Readonly<Record<string, keyof WorkbenchTextSearchOptions>> = {
  KeyC: 'matchCase',
  KeyW: 'wholeWord',
  KeyR: 'regex',
}

interface ProjectSearchFormProps {
  query: string
  search: WorkbenchProjectSearchModel
  onQueryChange: (query: string) => void
  /** 查找框里的上下、回车：交给结果列表挑行、打开（见 FilePanel）；用掉了返回 true。 */
  onQueryNavigationKey: (event: ReactKeyboardEvent<HTMLInputElement>) => boolean
}

/**
 * 项目搜索的表单（VS Code 的样子）：左边的箭头展开替换行；查找框后面是区分大小写、全字匹配、正则三个开关
 * （与编辑器查找栏同一套样子与快捷键），「⋯」展开包含 / 排除的文件。
 */
export function ProjectSearchForm({
  query,
  search,
  onQueryChange,
  onQueryNavigationKey,
}: ProjectSearchFormProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const queryInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const hasFilters = !!search.include.trim() || !!search.exclude.trim()
  const canReplaceAll = search.files.length > 0 && search.canReplace
  const { focusPending, acknowledgeFocus } = search

  useEffect(() => {
    if (!focusPending) return
    queryInputRef.current?.focus()
    queryInputRef.current?.select()
    acknowledgeFocus()
  }, [acknowledgeFocus, focusPending])

  // 刚展开替换行就把焦点给它。
  const replaceOpenedRef = useRef(search.replaceOpen)
  useEffect(() => {
    if (search.replaceOpen && !replaceOpenedRef.current) replaceInputRef.current?.focus()
    replaceOpenedRef.current = search.replaceOpen
  }, [search.replaceOpen])

  /** 几个输入框共用的按键：开关项的快捷键；Esc 在别的框里回到查找框。用掉了返回 true。 */
  function handleSharedKeys(event: ReactKeyboardEvent<HTMLInputElement>, inQuery: boolean): boolean {
    const optionShortcut = isApplePlatform
      ? event.altKey && event.metaKey
      : event.altKey && !event.ctrlKey
    if (optionShortcut && OptionShortcutCodes[event.code]) {
      search.toggleOption(OptionShortcutCodes[event.code]!)
    } else if (event.key === 'Escape') {
      if (inQuery) search.closePanel()
      else queryInputRef.current?.focus()
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  return (
    <div className={styles.projectSearchForm} data-replace-open={search.replaceOpen || undefined}>
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={t('workbench.findToggleReplace')}
        aria-expanded={search.replaceOpen}
        className={styles.projectSearchReplaceToggle}
        onClick={search.toggleReplace}
      >
        <CaretRightIcon size={12} />
      </IconButton>
      <div className={styles.projectSearchRows}>
        <div className={styles.projectSearchInputRow}>
          <div className={styles.searchInputShell}>
            <SearchField
              ref={queryInputRef}
              size="sm"
              value={query}
              placeholder={t('workbench.projectSearchPlaceholder')}
              aria-invalid={!!search.regexError || undefined}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (handleSharedKeys(event, true)) return
                if (onQueryNavigationKey(event)) event.preventDefault()
              }}
            />
          </div>
          <OptionToggle
            label={t('workbench.findMatchCase')}
            active={search.options.matchCase}
            onToggle={() => search.toggleOption('matchCase')}
          >
            <span className={styles.editorFindOptionGlyph}>Aa</span>
          </OptionToggle>
          <OptionToggle
            label={t('workbench.findWholeWord')}
            active={search.options.wholeWord}
            onToggle={() => search.toggleOption('wholeWord')}
          >
            <span className={styles.editorFindOptionGlyph} data-underline>
              ab
            </span>
          </OptionToggle>
          <OptionToggle
            label={t('workbench.findRegex')}
            active={search.options.regex}
            onToggle={() => search.toggleOption('regex')}
          >
            <span className={styles.editorFindOptionGlyph}>.*</span>
          </OptionToggle>
          <OptionToggle
            label={t('workbench.projectSearchToggleDetails')}
            active={search.detailsOpen || hasFilters}
            expanded={search.detailsOpen}
            onToggle={search.toggleDetails}
          >
            <DotsThreeIcon size={14} weight="bold" />
          </OptionToggle>
        </div>
        {!!search.regexError && (
          <Text tone="caption" className={styles.projectSearchError}>
            {t('workbench.findInvalidRegex')}: {search.regexError}
          </Text>
        )}
        {search.replaceOpen && (
          <div className={styles.projectSearchInputRow}>
            <Input
              ref={replaceInputRef}
              size="sm"
              value={search.replacement}
              placeholder={t('workbench.findReplacePlaceholder')}
              className={styles.projectSearchInput}
              onChange={(event) => search.setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (handleSharedKeys(event, false)) return
                if (event.key !== 'Enter' || !(isApplePlatform ? event.metaKey : event.ctrlKey)) return
                // ⌘Enter / Ctrl+Enter 全部替换（先确认）；焦点在输入框里，全局的「运行上次命令」不跟着跑。
                event.preventDefault()
                if (canReplaceAll) search.replaceAll()
              }}
            />
            <Button size="sm" variant="ghost" disabled={!canReplaceAll} onClick={search.replaceAll}>
              {t('workbench.findReplaceAll')}
            </Button>
          </div>
        )}
        {search.detailsOpen && (
          <>
            <Input
              size="sm"
              value={search.include}
              placeholder={t('workbench.projectSearchInclude')}
              aria-label={t('workbench.projectSearchInclude')}
              className={styles.projectSearchInput}
              onChange={(event) => search.setInclude(event.target.value)}
              onKeyDown={(event) => void handleSharedKeys(event, false)}
            />
            <Input
              size="sm"
              value={search.exclude}
              placeholder={t('workbench.projectSearchExclude')}
              aria-label={t('workbench.projectSearchExclude')}
              className={styles.projectSearchInput}
              onChange={(event) => search.setExclude(event.target.value)}
              onKeyDown={(event) => void handleSharedKeys(event, false)}
            />
          </>
        )}
      </div>
    </div>
  )
}

/** 结果上方的一行：共几处、在几个文件里（或「正在搜索」）、截断与跳过的说明，以及重搜、全部收起 / 展开。 */
export function ProjectSearchSummary({ search }: { search: WorkbenchProjectSearchModel }): ReactElement {
  const { t } = useWorkbenchI18n()
  const { summary } = search
  const allCollapsed =
    search.files.length > 0 && search.files.every((file) => search.collapsedPaths.has(file.path))
  const status = search.isSearching
    ? t('workbench.searching')
    : summary.matchCount > 0
      ? t('workbench.projectSearchSummary', {
          matches: formatWorkbenchProjectSearchCount(t, 'match', summary.matchCount),
          files: formatWorkbenchProjectSearchCount(t, 'file', summary.fileCount),
        })
      : t('workbench.projectSearchNoContentMatches')

  return (
    <div className={styles.projectSearchSummary}>
      <div className={styles.projectSearchSummaryRow}>
        <Text truncate tone="caption" className={styles.projectSearchSummaryText} aria-live="polite">
          {status}
        </Text>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t('workbench.projectSearchRefresh')}
          onClick={search.refresh}
        >
          <ArrowsClockwiseIcon size={13} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={allCollapsed ? t('workbench.projectSearchExpandAll') : t('workbench.projectSearchCollapseAll')}
          disabled={search.files.length === 0}
          onClick={() => search.setAllFilesCollapsed(!allCollapsed)}
        >
          {allCollapsed ? <ArrowsOutLineVerticalIcon size={13} /> : <ArrowsInLineVerticalIcon size={13} />}
        </IconButton>
      </div>
      {search.truncated && (
        <Text tone="caption" className={styles.projectSearchNotice} data-tone="warning">
          {t('workbench.projectSearchTruncated', { limit: WorkbenchProjectSearchLimit })}
        </Text>
      )}
      {search.skippedLargeFileCount > 0 && (
        <Text tone="caption" className={styles.projectSearchNotice}>
          {t('workbench.projectSearchSkippedLarge', {
            files: formatWorkbenchProjectSearchCount(t, 'file', search.skippedLargeFileCount),
          })}
        </Text>
      )}
    </div>
  )
}

function OptionToggle({
  label,
  active,
  expanded,
  onToggle,
  children,
}: {
  label: string
  active: boolean
  /** 展开 / 收起类的按钮（「⋯」）用 aria-expanded，开关类用 aria-pressed。 */
  expanded?: boolean
  onToggle: () => void
  children: ReactNode
}): ReactElement {
  return (
    <IconButton
      variant="ghost"
      size="icon-sm"
      label={label}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-expanded={expanded}
      data-active={active || undefined}
      className={styles.editorFindOption}
      onClick={onToggle}
    >
      {children}
    </IconButton>
  )
}
