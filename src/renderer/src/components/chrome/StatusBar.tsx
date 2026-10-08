import { type ReactElement, useState, useSyncExternalStore } from 'react'
import { CaretRightIcon, CheckIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type { WorkbenchStatusBarTextFormat } from '@renderer/models/editor/workbenchEditorTextFormat'
import {
  formatWorkbenchEditorVimMode,
  getWorkbenchEditorVimModeSnapshot,
  subscribeWorkbenchEditorVimMode,
} from '@renderer/models/editor/workbenchEditorVim'
import type {
  WorkbenchIndentation,
  WorkbenchIndentationChange,
} from '@renderer/models/editor/workbenchIndentation'

import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { AnchoredPopover } from '@velaros-ai/ui/primitives/overlays/AnchoredPopover'

import {
  formatWorkbenchTextEncoding,
  formatWorkbenchTextEol,
  type WorkbenchTextEol,
} from '@shared/workbenchTextFormat'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'
import { WorkbenchUpdateProgress } from '../WorkbenchUpdateProgress'

interface StatusBarProps {
  projectName: string
  selectedFilePath: Nullable<string>
  cursorPosition: {
    line: number
    column: number
  }
  hasUnsavedChanges: boolean
  /** 当前文件处于只读模式（或无法在编辑器里修改）。 */
  readOnly?: boolean
  isSavingFile: boolean
  openFileCount: number
  commandStatusLabel: string
  /** 当前文本文件的编码与换行符；图片、差异、预览等标签不显示。 */
  textFormat?: Nullable<WorkbenchStatusBarTextFormat>
  /** 在状态栏选了换行符：转换、标记为未保存并立即保存。 */
  onChangeEol?: (eol: WorkbenchTextEol) => void
  /** 代码编辑器里当前文件的缩进；不在代码编辑器里时不显示。 */
  indentation?: Nullable<WorkbenchIndentation>
  onChangeIndentation?: (change: WorkbenchIndentationChange) => void
}

/** 状态栏换行符菜单提供的选择；CR 只显示、不提供（没有编辑器再写它）。 */
const StatusBarEolOptions: readonly WorkbenchTextEol[] = ['lf', 'crlf']

/** 状态栏缩进菜单里可选的缩进。 */
const StatusBarIndentationOptions: ReadonlyArray<{ style: 'space' | 'tab'; size: number }> = [
  { style: 'space', size: 2 },
  { style: 'space', size: 4 },
  { style: 'space', size: 8 },
  { style: 'tab', size: 2 },
  { style: 'tab', size: 4 },
  { style: 'tab', size: 8 },
]

export function StatusBar({
  projectName,
  selectedFilePath,
  cursorPosition,
  hasUnsavedChanges,
  readOnly = false,
  isSavingFile,
  openFileCount,
  commandStatusLabel,
  textFormat = null,
  onChangeEol,
  indentation = null,
  onChangeIndentation,
}: StatusBarProps): ReactElement {
  const { t } = useWorkbenchI18n()
  // Vim 键位方案下眼前那个编辑器的模式；没有编辑器开着 Vim 就不显示。
  const vimMode = useSyncExternalStore(
    subscribeWorkbenchEditorVimMode,
    getWorkbenchEditorVimModeSnapshot,
    () => null
  )
  const pathSegments = selectedFilePath?.split('/').filter((value) => !!value) ?? []
  const fileName = pathSegments.at(-1) ?? ''

  return (
    <footer className={styles.statusBar}>
      {selectedFilePath ? (
        <div className={styles.statusPathTrail} title={`${projectName}/${selectedFilePath}`}>
          <Text truncate tone="caption" className={styles.statusPathSegment}>
            {projectName}
          </Text>
          {pathSegments.map((segment, index) => {
            const isFile = index === pathSegments.length - 1

            return (
              <span key={`${index}:${segment}`} className={styles.statusPathPart}>
                <CaretRightIcon size={11} className={styles.statusPathSeparator} />
                <Text
                  truncate
                  tone="caption"
                  className={isFile ? styles.statusPathFile : styles.statusPathSegment}
                >
                  {isFile && <WorkbenchFileTypeIcon fileName={fileName} size={13} />}
                  <span>{segment}</span>
                </Text>
              </span>
            )
          })}
        </div>
      ) : (
        <Text truncate tone="caption" className={styles.statusBarItem}>
          {t('workbench.noFileSelected')}
        </Text>
      )}
      {!!vimMode && (
        <Text
          truncate
          tone="caption"
          className={styles.statusBarItem}
          title={t('workbench.vimModeTitle')}
          data-vim-mode={vimMode}
        >
          {formatWorkbenchEditorVimMode(vimMode)}
        </Text>
      )}
      <Text truncate tone="caption" className={styles.statusBarItem}>
        {t('workbench.cursorPosition', cursorPosition)}
      </Text>
      {!!indentation && (
        <StatusBarIndentation
          indentation={indentation}
          readOnly={readOnly}
          onChangeIndentation={onChangeIndentation}
        />
      )}
      {!!textFormat && <StatusBarTextFormat format={textFormat} onChangeEol={onChangeEol} />}
      {!!selectedFilePath && (
        <Text truncate tone="caption" className={styles.statusBarItem}>
          {isSavingFile
            ? t('workbench.saving')
            : hasUnsavedChanges
              ? t('workbench.unsaved')
              : t('workbench.saved')}
        </Text>
      )}
      {!!selectedFilePath && readOnly && (
        <Text truncate tone="caption" className={styles.statusBarItem}>
          {t('workbench.readOnlyFile')}
        </Text>
      )}
      <span className={styles.statusBarSpacer} />
      <WorkbenchUpdateProgress />
      <Text truncate tone="caption" className={styles.statusBarItem}>
        {t('workbench.openFileCount', { count: openFileCount })}
      </Text>
      <Text truncate tone="caption" className={styles.statusBarItem}>
        {commandStatusLabel}
      </Text>
    </footer>
  )
}

/** 缩进（「空格: 4」「制表符宽度: 4」）：点开能改用别的缩进、把现有缩进转换过去，或回到按内容识别。 */
function StatusBarIndentation({
  indentation,
  readOnly,
  onChangeIndentation,
}: {
  indentation: WorkbenchIndentation
  readOnly: boolean
  onChangeIndentation?: (change: WorkbenchIndentationChange) => void
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const label =
    indentation.style === 'tab'
      ? t('workbench.indentationTabs', { size: indentation.tabSize })
      : t('workbench.indentationSpaces', { size: indentation.size })
  const title = t('workbench.indentationTitle', {
    indentation: label,
    source: t(
      indentation.source === 'override'
        ? 'workbench.indentationSourceOverride'
        : indentation.source === 'editorconfig'
          ? 'workbench.indentationSourceEditorConfig'
          : indentation.source === 'detected'
            ? 'workbench.indentationSourceDetected'
            : 'workbench.indentationSourceDefault'
    ),
  })
  if (!onChangeIndentation)
    return (
      <Text truncate tone="caption" className={styles.statusBarItem} title={title}>
        {label}
      </Text>
    )

  const choose = (change: WorkbenchIndentationChange): void => {
    setMenuOpen(false)
    onChangeIndentation(change)
  }
  const convertTo = indentation.style === 'tab' ? 'space' : 'tab'
  return (
    <AnchoredPopover
      open={menuOpen}
      onOpenChange={setMenuOpen}
      side="top"
      align="end"
      sideOffset={6}
      widthStrategy="content"
      className={styles.statusEolMenu}
      anchor={({ getAnchorProps }) => (
        <button
          {...getAnchorProps<HTMLButtonElement>()}
          type="button"
          className={styles.statusBarItem}
          title={title}
          aria-haspopup="menu"
        >
          {label}
        </button>
      )}
    >
      <div role="menu" aria-label={t('workbench.indentationMenuLabel')}>
        {StatusBarIndentationOptions.map((option) => {
          const current =
            option.style === indentation.style
            && option.size === (option.style === 'tab' ? indentation.tabSize : indentation.size)
          return (
            <button
              key={`${option.style}:${option.size}`}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              className={styles.statusEolMenuItem}
              onClick={() => choose({ kind: 'use', ...option })}
            >
              <span>
                {option.style === 'tab'
                  ? t('workbench.indentationUseTabs', { size: option.size })
                  : t('workbench.indentationUseSpaces', { size: option.size })}
              </span>
              {current && <CheckIcon size={12} weight="bold" />}
            </button>
          )
        })}
        <div role="separator" className={styles.statusMenuSeparator} />
        <button
          type="button"
          role="menuitem"
          disabled={readOnly}
          className={styles.statusEolMenuItem}
          onClick={() => choose({ kind: 'convert', style: convertTo })}
        >
          <span>
            {convertTo === 'tab'
              ? t('workbench.indentationConvertToTabs')
              : t('workbench.indentationConvertToSpaces')}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={styles.statusEolMenuItem}
          onClick={() => choose({ kind: 'detect' })}
        >
          <span>{t('workbench.indentationDetect')}</span>
        </button>
      </div>
    </AnchoredPopover>
  )
}

function StatusBarTextFormat({
  format,
  onChangeEol,
}: {
  format: WorkbenchStatusBarTextFormat
  onChangeEol?: (eol: WorkbenchTextEol) => void
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const encoding = formatWorkbenchTextEncoding(format.encoding)
  const eol = formatWorkbenchTextEol(format.eol)
  const eolLabel = format.mixedEol ? t('workbench.textEolMixed', { eol }) : eol

  return (
    <>
      <Text
        truncate
        tone="caption"
        className={styles.statusBarItem}
        title={t('workbench.textEncodingTitle', { encoding })}
      >
        {encoding}
      </Text>
      {format.canChangeEol && onChangeEol ? (
        <AnchoredPopover
          open={menuOpen}
          onOpenChange={setMenuOpen}
          side="top"
          align="end"
          sideOffset={6}
          widthStrategy="content"
          className={styles.statusEolMenu}
          anchor={({ getAnchorProps }) => (
            <button
              {...getAnchorProps<HTMLButtonElement>()}
              type="button"
              className={styles.statusBarItem}
              title={t('workbench.textEolChangeTitle', { eol: eolLabel })}
              aria-haspopup="menu"
            >
              {eolLabel}
            </button>
          )}
        >
          <div role="menu" aria-label={t('workbench.textEolMenuLabel')}>
            {StatusBarEolOptions.map((option) => {
              const current = option === format.eol && !format.mixedEol
              return (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  className={styles.statusEolMenuItem}
                  onClick={() => {
                    setMenuOpen(false)
                    onChangeEol(option)
                  }}
                >
                  <span>
                    {option === 'lf'
                      ? t('workbench.textEolOptionLf')
                      : t('workbench.textEolOptionCrlf')}
                  </span>
                  {current && <CheckIcon size={12} weight="bold" />}
                </button>
              )
            })}
          </div>
        </AnchoredPopover>
      ) : (
        <Text
          truncate
          tone="caption"
          className={styles.statusBarItem}
          title={t('workbench.textEolTitle', { eol: eolLabel })}
        >
          {eolLabel}
        </Text>
      )}
    </>
  )
}
