import { type ReactElement, useEffect, useRef } from 'react'
import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchTerminalFindOptions } from '@renderer/models/commands/workbenchTerminalFind'
import type { WorkbenchEditorFindStatus } from '@renderer/models/editor/workbenchEditorFindState'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'

import styles from '../../styles/workbenchPageStyles'
import { FindOptionToggle } from '../editor/EditorFindBar'

interface WorkbenchTerminalFindBarProps {
  query: string
  options: WorkbenchTerminalFindOptions
  status: WorkbenchEditorFindStatus
  /** 每要求一次「聚焦查找框并全选」就加一（查找栏开着时在终端里再按 ⌘F 也算）。 */
  focusRequest: number
  onQueryChange: (query: string) => void
  onToggleOption: (option: keyof WorkbenchTerminalFindOptions) => void
  onFindNext: () => void
  onFindPrevious: () => void
  onClose: () => void
}

const isApplePlatform = /Mac|iPhone|iPad/u.test(navigator.platform)

/** 开关项的快捷键与编辑器查找栏一致：macOS 上 ⌥⌘C / ⌥⌘W / ⌥⌘R，其它平台 Alt+C / W / R。 */
const OptionShortcutCodes: Readonly<Record<string, keyof WorkbenchTerminalFindOptions>> = {
  KeyC: 'caseSensitive',
  KeyW: 'wholeWord',
  KeyR: 'regexp',
}

/**
 * 终端的查找栏：浮在终端右上角，不占终端的行（开关它不会让伪终端改尺寸、让全屏程序重画）。按键与编辑器查找栏
 * 一致：回车下一处、Shift+回车上一处、F3 / Shift+F3 同样，Esc 关闭。
 */
export function WorkbenchTerminalFindBar({
  query,
  options,
  status,
  focusRequest,
  onQueryChange,
  onToggleOption,
  onFindNext,
  onFindPrevious,
  onClose,
}: WorkbenchTerminalFindBarProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const queryInputRef = useRef<HTMLInputElement>(null)
  const hasMatches = status.total > 0

  useEffect(() => {
    queryInputRef.current?.focus()
    queryInputRef.current?.select()
  }, [focusRequest])

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
    <div className={styles.terminalFindBar} data-terminal-chrome="true">
      <div className={styles.editorFindSearchField}>
        <SearchField
          ref={queryInputRef}
          size="sm"
          value={query}
          placeholder={t('workbench.findInTerminal')}
          aria-invalid={status.invalid || undefined}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            const primary = isApplePlatform ? event.metaKey : event.ctrlKey
            const optionShortcut = isApplePlatform
              ? event.altKey && event.metaKey
              : event.altKey && !event.ctrlKey
            if (event.key === 'Escape') {
              onClose()
            } else if (event.key === 'Enter' || event.key === 'F3') {
              if (event.shiftKey) onFindPrevious()
              else onFindNext()
            } else if (primary && !event.altKey && !event.shiftKey && event.code === 'KeyF') {
              queryInputRef.current?.select()
            } else if (optionShortcut && OptionShortcutCodes[event.code]) {
              onToggleOption(OptionShortcutCodes[event.code]!)
            } else {
              return
            }
            event.preventDefault()
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
  )
}
