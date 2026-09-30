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
  FunnelSimpleIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react'
import {
  type WorkbenchProjectSearchEngine,
  WorkbenchProjectSearchLimit,
} from '@renderer/hooks/useWorkbenchProjectSearchEngine'
import type { WorkbenchProjectSearchPanelModel } from '@renderer/hooks/useWorkbenchProjectSearchPanel'
import { useWorkbenchI18n } from '@renderer/i18n'
import { formatWorkbenchProjectSearchCount } from '@renderer/models/files/workbenchProjectSearchModel'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'

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
  /** 表单里的条件与开关（跟着页面走）。 */
  panel: WorkbenchProjectSearchPanelModel
  /** 搜索与替换本身：正则写错的说明、能不能全部替换。 */
  engine: WorkbenchProjectSearchEngine
  onQueryChange: (query: string) => void
  /** 查找框里的上下、回车：交给结果列表挑行、打开（见 ProjectSearchView）；用掉了返回 true。 */
  onQueryNavigationKey: (event: ReactKeyboardEvent<HTMLInputElement>) => boolean
}

/**
 * 项目搜索的表单（VS Code 的样子）：左边的箭头展开替换行，右边一列输入框，全都一样宽、一样的边框。
 * 区分大小写、全字匹配、正则三个开关收在查找框里靠右（与编辑器查找栏同一套快捷键），后面的漏斗展开
 * 包含 / 排除的文件；「全部替换」收在替换框里靠右。
 */
export function ProjectSearchForm({
  query,
  panel,
  engine,
  onQueryChange,
  onQueryNavigationKey,
}: ProjectSearchFormProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const queryInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const hasFilters = !!panel.include.trim() || !!panel.exclude.trim()
  const canReplaceAll = engine.files.length > 0 && engine.canReplace
  const { focusPending, acknowledgeFocus } = panel

  useEffect(() => {
    if (!focusPending) return
    queryInputRef.current?.focus()
    queryInputRef.current?.select()
    acknowledgeFocus()
  }, [acknowledgeFocus, focusPending])

  // 刚展开替换行就把焦点给它。
  const replaceOpenedRef = useRef(panel.replaceOpen)
  useEffect(() => {
    if (panel.replaceOpen && !replaceOpenedRef.current) replaceInputRef.current?.focus()
    replaceOpenedRef.current = panel.replaceOpen
  }, [panel.replaceOpen])

  /** 几个输入框共用的按键：开关项的快捷键；Esc 在别的框里回到查找框。用掉了返回 true。 */
  function handleSharedKeys(event: ReactKeyboardEvent<HTMLInputElement>, inQuery: boolean): boolean {
    const optionShortcut = isApplePlatform
      ? event.altKey && event.metaKey
      : event.altKey && !event.ctrlKey
    if (optionShortcut && OptionShortcutCodes[event.code]) {
      panel.toggleOption(OptionShortcutCodes[event.code]!)
    } else if (event.key === 'Escape') {
      if (inQuery) panel.closePanel()
      else queryInputRef.current?.focus()
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  return (
    <div
      className={styles.projectSearchForm}
      data-project-search-form
      data-replace-open={panel.replaceOpen || undefined}
    >
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={t('workbench.findToggleReplace')}
        aria-expanded={panel.replaceOpen}
        className={styles.projectSearchReplaceToggle}
        onClick={panel.toggleReplace}
      >
        <CaretRightIcon size={12} />
      </IconButton>
      <div className={styles.projectSearchRows}>
        <div className={styles.projectSearchField} data-invalid={!!engine.regexError || undefined}>
          <MagnifyingGlassIcon size={14} className={styles.projectSearchFieldIcon} aria-hidden />
          <Input
            ref={queryInputRef}
            variant="ghost"
            size="sm"
            type="search"
            value={query}
            placeholder={t('workbench.projectSearchPlaceholder')}
            aria-label={t('workbench.projectSearchPlaceholder')}
            aria-invalid={!!engine.regexError || undefined}
            className={styles.projectSearchInput}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (handleSharedKeys(event, true)) return
              if (onQueryNavigationKey(event)) event.preventDefault()
            }}
          />
          <FieldToggle
            label={t('workbench.findMatchCase')}
            active={panel.options.matchCase}
            onToggle={() => panel.toggleOption('matchCase')}
          >
            Aa
          </FieldToggle>
          <FieldToggle
            label={t('workbench.findWholeWord')}
            active={panel.options.wholeWord}
            onToggle={() => panel.toggleOption('wholeWord')}
          >
            <span data-underline>ab</span>
          </FieldToggle>
          <FieldToggle
            label={t('workbench.findRegex')}
            active={panel.options.regex}
            onToggle={() => panel.toggleOption('regex')}
          >
            .*
          </FieldToggle>
          <span className={styles.projectSearchFieldDivider} aria-hidden />
          <FieldToggle
            label={t('workbench.projectSearchToggleDetails')}
            active={panel.detailsOpen || hasFilters}
            expanded={panel.detailsOpen}
            onToggle={panel.toggleDetails}
          >
            <FunnelSimpleIcon size={13} />
          </FieldToggle>
        </div>
        {!!engine.regexError && (
          <Text tone="caption" className={styles.projectSearchError}>
            {t('workbench.findInvalidRegex')}: {engine.regexError}
          </Text>
        )}
        {panel.replaceOpen && (
          <div className={styles.projectSearchField}>
            <Input
              ref={replaceInputRef}
              variant="ghost"
              size="sm"
              value={panel.replacement}
              placeholder={t('workbench.findReplacePlaceholder')}
              aria-label={t('workbench.findReplacePlaceholder')}
              className={styles.projectSearchInput}
              onChange={(event) => panel.setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (handleSharedKeys(event, false)) return
                if (event.key !== 'Enter' || !(isApplePlatform ? event.metaKey : event.ctrlKey)) return
                // ⌘Enter / Ctrl+Enter 全部替换（先确认）；焦点在输入框里，全局的「运行上次命令」不跟着跑。
                event.preventDefault()
                if (canReplaceAll) engine.replaceAll()
              }}
            />
            <button
              type="button"
              className={styles.projectSearchFieldAction}
              disabled={!canReplaceAll}
              onClick={engine.replaceAll}
            >
              {t('workbench.findReplaceAll')}
            </button>
          </div>
        )}
        {panel.detailsOpen && (
          <>
            <div className={styles.projectSearchField}>
              <Input
                variant="ghost"
                size="sm"
                value={panel.include}
                placeholder={t('workbench.projectSearchInclude')}
                aria-label={t('workbench.projectSearchInclude')}
                className={styles.projectSearchInput}
                onChange={(event) => panel.setInclude(event.target.value)}
                onKeyDown={(event) => void handleSharedKeys(event, false)}
              />
            </div>
            <div className={styles.projectSearchField}>
              <Input
                variant="ghost"
                size="sm"
                value={panel.exclude}
                placeholder={t('workbench.projectSearchExclude')}
                aria-label={t('workbench.projectSearchExclude')}
                className={styles.projectSearchInput}
                onChange={(event) => panel.setExclude(event.target.value)}
                onKeyDown={(event) => void handleSharedKeys(event, false)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 结果上方的一行：共几处、在几个文件里（或「正在搜索」）、没搜完 / 截断 / 跳过的说明，以及重搜、
 * 全部收起 / 展开。
 */
export function ProjectSearchSummary({ engine }: { engine: WorkbenchProjectSearchEngine }): ReactElement {
  const { t } = useWorkbenchI18n()
  const { summary } = engine
  const allCollapsed =
    engine.files.length > 0 && engine.files.every((file) => engine.collapsedPaths.has(file.path))
  const status = engine.isSearching
    ? t('workbench.searching')
    : summary.matchCount > 0
      ? t('workbench.projectSearchSummary', {
          matches: formatWorkbenchProjectSearchCount(t, 'match', summary.matchCount),
          files: formatWorkbenchProjectSearchCount(t, 'file', summary.fileCount),
        })
      : engine.failure
        ? t('workbench.searchFailed')
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
          onClick={engine.refresh}
        >
          <ArrowsClockwiseIcon size={13} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={allCollapsed ? t('workbench.projectSearchExpandAll') : t('workbench.projectSearchCollapseAll')}
          disabled={engine.files.length === 0}
          onClick={() => engine.setAllFilesCollapsed(!allCollapsed)}
        >
          {allCollapsed ? <ArrowsOutLineVerticalIcon size={13} /> : <ArrowsInLineVerticalIcon size={13} />}
        </IconButton>
      </div>
      {!!engine.failure && (
        <Text tone="caption" className={styles.projectSearchNotice} data-tone="warning">
          {t('workbench.projectSearchIncomplete', { message: engine.failure })}
        </Text>
      )}
      {engine.truncated && (
        <Text tone="caption" className={styles.projectSearchNotice} data-tone="warning">
          {t('workbench.projectSearchTruncated', { limit: WorkbenchProjectSearchLimit })}
        </Text>
      )}
      {engine.skippedLargeFileCount > 0 && (
        <Text tone="caption" className={styles.projectSearchNotice}>
          {t('workbench.projectSearchSkippedLarge', {
            files: formatWorkbenchProjectSearchCount(t, 'file', engine.skippedLargeFileCount),
          })}
        </Text>
      )}
    </div>
  )
}

/** 查找框里靠右的小开关：区分大小写、全字匹配、正则，以及展开包含 / 排除的那一个。 */
function FieldToggle({
  label,
  active,
  expanded,
  onToggle,
  children,
}: {
  label: string
  active: boolean
  /** 展开 / 收起类的按钮（漏斗）用 aria-expanded，开关类用 aria-pressed。 */
  expanded?: boolean
  onToggle: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-expanded={expanded}
      data-active={active || undefined}
      className={styles.projectSearchFieldToggle}
      onClick={onToggle}
    >
      {children}
    </button>
  )
}
