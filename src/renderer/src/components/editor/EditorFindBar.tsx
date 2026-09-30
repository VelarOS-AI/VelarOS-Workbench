import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
} from 'react'
import { CaretDownIcon, CaretRightIcon, CaretUpIcon, SelectionIcon, XIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type {
  WorkbenchEditorFindOptions,
  WorkbenchEditorFindStatus,
} from '@renderer/models/editor/workbenchEditorFindState'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'

import styles from '../../styles/workbenchPageStyles'

interface EditorFindBarProps {
  query: string
  replace: string
  options: WorkbenchEditorFindOptions
  status: WorkbenchEditorFindStatus
  replaceOpen: boolean
  /** 只读文件不能替换。 */
  readOnly: boolean
  /** 每要求一次「聚焦查找框并全选」就加一（查找栏开着时再按 ⌘F 也算）。 */
  focusRequest: number
  onQueryChange: (query: string) => void
  onReplaceChange: (replace: string) => void
  onToggleOption: (option: keyof WorkbenchEditorFindOptions) => void
  onToggleReplace: () => void
  onFindNext: () => void
  onFindPrevious: () => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}

const isApplePlatform = /Mac|iPhone|iPad/u.test(navigator.platform)

/**
 * 开关项的快捷键，与 VS Code 一致：macOS 上 ⌥⌘C / ⌥⌘W / ⌥⌘R / ⌥⌘L，其它平台 Alt+C / W / R / L。按物理键认：
 * macOS 上单按 ⌥C 是在打 ç，不能拦。
 */
const OptionShortcutCodes: Readonly<Record<string, keyof WorkbenchEditorFindOptions>> = {
  KeyC: 'caseSensitive',
  KeyW: 'wholeWord',
  KeyR: 'regexp',
  KeyL: 'inSelection',
}

export function EditorFindBar({
  query,
  replace,
  options,
  status,
  replaceOpen,
  readOnly,
  focusRequest,
  onQueryChange,
  onReplaceChange,
  onToggleOption,
  onToggleReplace,
  onFindNext,
  onFindPrevious,
  onReplace,
  onReplaceAll,
  onClose,
}: EditorFindBarProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const queryInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const hasMatches = status.total > 0
  const canReplace = hasMatches && !readOnly

  useEffect(() => {
    queryInputRef.current?.focus()
    queryInputRef.current?.select()
  }, [focusRequest])

  // 刚展开替换行就把焦点给它（⌥⌘F / Ctrl+H 打开时）。
  const replaceOpenedRef = useRef(replaceOpen)
  useEffect(() => {
    if (replaceOpen && !replaceOpenedRef.current) replaceInputRef.current?.focus()
    replaceOpenedRef.current = replaceOpen
  }, [replaceOpen])

  /**
   * 两个输入框共用的按键：Esc 关闭、⌘F 回到查找框、⌥⌘F（其它平台 Ctrl+H）展开替换、开关项快捷键。macOS 上 Ctrl+F、
   * Ctrl+H 是输入框里的移动与删除键，只认 ⌘。
   */
  const handleSharedKeys = (event: ReactKeyboardEvent<HTMLInputElement>): boolean => {
    const primary = isApplePlatform ? event.metaKey : event.ctrlKey
    const optionShortcut = isApplePlatform ? event.altKey && event.metaKey : event.altKey && !event.ctrlKey
    if (event.key === 'Escape') {
      onClose()
    } else if (primary && !event.altKey && event.code === 'KeyF') {
      queryInputRef.current?.focus()
      queryInputRef.current?.select()
    } else if (
      isApplePlatform ? primary && event.altKey && event.code === 'KeyF' : primary && event.code === 'KeyH'
    ) {
      if (replaceOpen) replaceInputRef.current?.focus()
      else onToggleReplace()
    } else if (optionShortcut && OptionShortcutCodes[event.code]) {
      onToggleOption(OptionShortcutCodes[event.code]!)
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  const countText = !query
    ? ''
    : status.invalid
      ? t('workbench.findInvalidRegex')
      : !hasMatches
        ? t('workbench.findNoMatches')
        : t('workbench.findMatchCount', {
            current: status.current || '?',
            total: status.limited ? `${status.total}+` : status.total,
          })

  return (
    <div className={styles.editorFindBar} data-replace-open={replaceOpen || undefined}>
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={t('workbench.findToggleReplace')}
        aria-expanded={replaceOpen}
        className={styles.editorFindReplaceToggle}
        onClick={onToggleReplace}
      >
        <CaretRightIcon size={12} />
      </IconButton>
      <div className={styles.editorFindRows}>
        <div className={styles.editorFindRow}>
          <div className={styles.editorFindSearchField}>
            <SearchField
              ref={queryInputRef}
              size="sm"
              value={query}
              placeholder={t('workbench.findInFile')}
              aria-invalid={status.invalid || undefined}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (handleSharedKeys(event)) return
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (event.shiftKey) onFindPrevious()
                else onFindNext()
              }}
            />
          </div>
          <FindOptionToggle
            label={t('workbench.findMatchCase')}
            active={options.caseSensitive}
            onToggle={() => onToggleOption('caseSensitive')}
          >
            <span className={styles.editorFindOptionGlyph}>Aa</span>
          </FindOptionToggle>
          <FindOptionToggle
            label={t('workbench.findWholeWord')}
            active={options.wholeWord}
            onToggle={() => onToggleOption('wholeWord')}
          >
            <span className={styles.editorFindOptionGlyph} data-underline>
              ab
            </span>
          </FindOptionToggle>
          <FindOptionToggle
            label={t('workbench.findRegex')}
            active={options.regexp}
            onToggle={() => onToggleOption('regexp')}
          >
            <span className={styles.editorFindOptionGlyph}>.*</span>
          </FindOptionToggle>
          <FindOptionToggle
            label={t('workbench.findInSelection')}
            active={options.inSelection}
            onToggle={() => onToggleOption('inSelection')}
          >
            <SelectionIcon size={14} />
          </FindOptionToggle>
          <Text
            className={styles.editorFindMeta}
            tone="caption"
            data-error={status.invalid || (!!query && !hasMatches) || undefined}
          >
            {countText}
          </Text>
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={t('workbench.findPrevious')}
            disabled={!hasMatches}
            onClick={onFindPrevious}
          >
            <CaretUpIcon size={14} />
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={t('workbench.findNext')}
            disabled={!hasMatches}
            onClick={onFindNext}
          >
            <CaretDownIcon size={14} />
          </IconButton>
          <IconButton variant="ghost" size="icon-sm" label={t('common.cancel')} onClick={onClose}>
            <XIcon size={14} />
          </IconButton>
        </div>
        {replaceOpen && (
          <div className={styles.editorFindRow}>
            <Input
              ref={replaceInputRef}
              size="sm"
              value={replace}
              disabled={readOnly}
              placeholder={t('workbench.findReplacePlaceholder')}
              className={styles.editorFindReplaceInput}
              onChange={(event) => onReplaceChange(event.target.value)}
              onKeyDown={(event) => {
                if (handleSharedKeys(event)) return
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (isApplePlatform ? event.metaKey : event.ctrlKey) onReplaceAll()
                else onReplace()
              }}
            />
            <Button size="sm" variant="ghost" disabled={!canReplace} onClick={onReplace}>
              {t('workbench.findReplace')}
            </Button>
            <Button size="sm" variant="ghost" disabled={!canReplace} onClick={onReplaceAll}>
              {t('workbench.findReplaceAll')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

export function FindOptionToggle({
  label,
  active,
  onToggle,
  children,
}: {
  label: string
  active: boolean
  onToggle: () => void
  children: ReactNode
}): ReactElement {
  return (
    <IconButton
      variant="ghost"
      size="icon-sm"
      label={label}
      aria-pressed={active}
      data-active={active || undefined}
      className={styles.editorFindOption}
      onClick={onToggle}
    >
      {children}
    </IconButton>
  )
}
