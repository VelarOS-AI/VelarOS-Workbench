import { ArrowCounterClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n, type WorkbenchMessageKey } from '@renderer/i18n'
import {
  getWorkbenchEditorCommandChords,
  WORKBENCH_EDITOR_KEYMAP_COMMANDS,
  type WorkbenchEditorKeymapCommandId,
} from '@renderer/models/editor/workbenchEditorKeymap'
import {
  formatWorkbenchShortcutForPlatform,
  shortcutFromWorkbenchKeyboardEvent,
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
  type WorkbenchKeymapConflict,
} from '@renderer/models/layout/workbenchKeyboardShortcuts'
import {
  DEFAULT_WORKBENCH_KEYMAP_PRESET,
  WORKBENCH_KEYMAP_PRESET_IDS,
  type WorkbenchKeymapPresetId,
} from '@renderer/models/layout/workbenchKeymapPresets'
import type { KeyboardEvent, ReactElement } from 'react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'

import styles from '../../styles/workbenchPageStyles'

import { SettingRow, WorkbenchSettingsPill } from './WorkbenchSettingsParts'

/** 方案的名字是产品名，两种界面语言里一样。 */
const PresetLabels: Record<WorkbenchKeymapPresetId, string> = {
  workbench: 'Workbench',
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  vim: 'Vim',
}

const PresetDescriptionKeys: Record<WorkbenchKeymapPresetId, WorkbenchMessageKey> = {
  workbench: 'workbench.settingsKeymapPresetWorkbenchDescription',
  vscode: 'workbench.settingsKeymapPresetVscodeDescription',
  jetbrains: 'workbench.settingsKeymapPresetJetbrainsDescription',
  vim: 'workbench.settingsKeymapPresetVimDescription',
}

const ShortcutLabelKeys: Record<WorkbenchKeyboardShortcutAction, WorkbenchMessageKey> = {
  'close-right-tool': 'workbench.settingsShortcutCloseRightTool',
  'command-palette': 'workbench.settingsShortcutCommandPalette',
  'debug-continue': 'workbench.settingsShortcutDebugContinue',
  'debug-step-into': 'workbench.settingsShortcutDebugStepInto',
  'debug-step-out': 'workbench.settingsShortcutDebugStepOut',
  'debug-step-over': 'workbench.settingsShortcutDebugStepOver',
  'debug-stop': 'workbench.settingsShortcutDebugStop',
  'find-in-files': 'workbench.settingsShortcutFindInFiles',
  'focus-left-editor-group': 'workbench.settingsShortcutFocusLeftEditorGroup',
  'focus-right-editor-group': 'workbench.settingsShortcutFocusRightEditorGroup',
  'go-to-symbol': 'workbench.settingsShortcutGoToSymbol',
  'navigate-back': 'workbench.settingsShortcutNavigateBack',
  'navigate-forward': 'workbench.settingsShortcutNavigateForward',
  'quick-open': 'workbench.settingsShortcutQuickOpen',
  'reopen-closed-tab': 'workbench.settingsShortcutReopenClosedTab',
  'run-last-command': 'workbench.settingsShortcutRunLastCommand',
  'save-all': 'workbench.settingsShortcutSaveAll',
  'save-current': 'workbench.settingsShortcutSaveCurrent',
  'split-editor-right': 'workbench.settingsShortcutSplitEditorRight',
  'toggle-actions': 'workbench.settingsShortcutToggleActions',
  'toggle-changes': 'workbench.settingsShortcutToggleChanges',
  'toggle-problems': 'workbench.settingsShortcutToggleProblems',
}

const ShortcutDescriptionKeys: Record<WorkbenchKeyboardShortcutAction, WorkbenchMessageKey> = {
  'close-right-tool': 'workbench.settingsShortcutCloseRightToolDescription',
  'command-palette': 'workbench.settingsShortcutCommandPaletteDescription',
  'debug-continue': 'workbench.settingsShortcutDebugContinueDescription',
  'debug-step-into': 'workbench.settingsShortcutDebugStepIntoDescription',
  'debug-step-out': 'workbench.settingsShortcutDebugStepOutDescription',
  'debug-step-over': 'workbench.settingsShortcutDebugStepOverDescription',
  'debug-stop': 'workbench.settingsShortcutDebugStopDescription',
  'find-in-files': 'workbench.settingsShortcutFindInFilesDescription',
  'focus-left-editor-group': 'workbench.settingsShortcutFocusLeftEditorGroupDescription',
  'focus-right-editor-group': 'workbench.settingsShortcutFocusRightEditorGroupDescription',
  'go-to-symbol': 'workbench.settingsShortcutGoToSymbolDescription',
  'navigate-back': 'workbench.settingsShortcutNavigateBackDescription',
  'navigate-forward': 'workbench.settingsShortcutNavigateForwardDescription',
  'quick-open': 'workbench.settingsShortcutQuickOpenDescription',
  'reopen-closed-tab': 'workbench.settingsShortcutReopenClosedTabDescription',
  'run-last-command': 'workbench.settingsShortcutRunLastCommandDescription',
  'save-all': 'workbench.settingsShortcutSaveAllDescription',
  'save-current': 'workbench.settingsShortcutSaveCurrentDescription',
  'split-editor-right': 'workbench.settingsShortcutSplitEditorRightDescription',
  'toggle-actions': 'workbench.settingsShortcutToggleActionsDescription',
  'toggle-changes': 'workbench.settingsShortcutToggleChangesDescription',
  'toggle-problems': 'workbench.settingsShortcutToggleProblemsDescription',
}

const EditorCommandLabelKeys: Record<WorkbenchEditorKeymapCommandId, WorkbenchMessageKey> = {
  'go-to-definition': 'workbench.settingsEditorKeyGoToDefinition',
  'find-references': 'workbench.settingsEditorKeyFindReferences',
  'call-hierarchy': 'workbench.settingsEditorKeyCallHierarchy',
  'rename-symbol': 'workbench.settingsEditorKeyRenameSymbol',
  'quick-fix': 'workbench.settingsEditorKeyQuickFix',
  refactor: 'workbench.settingsEditorKeyRefactor',
  'organize-imports': 'workbench.settingsEditorKeyOrganizeImports',
  'format-document': 'workbench.settingsEditorKeyFormatDocument',
  'trigger-completion': 'workbench.settingsEditorKeyTriggerCompletion',
  'next-problem': 'workbench.settingsEditorKeyNextProblem',
  'previous-problem': 'workbench.settingsEditorKeyPreviousProblem',
  'open-lint-panel': 'workbench.settingsEditorKeyOpenLintPanel',
  find: 'workbench.settingsEditorKeyFind',
  replace: 'workbench.settingsEditorKeyReplace',
  'find-next': 'workbench.settingsEditorKeyFindNext',
  'find-previous': 'workbench.settingsEditorKeyFindPrevious',
  'go-to-line': 'workbench.settingsEditorKeyGoToLine',
  'navigate-back': 'workbench.settingsEditorKeyNavigateBack',
  'navigate-forward': 'workbench.settingsEditorKeyNavigateForward',
  save: 'workbench.settingsEditorKeySave',
  'toggle-line-comment': 'workbench.settingsEditorKeyToggleLineComment',
  'toggle-block-comment': 'workbench.settingsEditorKeyToggleBlockComment',
  'indent-more': 'workbench.settingsEditorKeyIndentMore',
  'indent-less': 'workbench.settingsEditorKeyIndentLess',
  'reindent-selection': 'workbench.settingsEditorKeyReindentSelection',
  'move-line-up': 'workbench.settingsEditorKeyMoveLineUp',
  'move-line-down': 'workbench.settingsEditorKeyMoveLineDown',
  'copy-line-up': 'workbench.settingsEditorKeyCopyLineUp',
  'copy-line-down': 'workbench.settingsEditorKeyCopyLineDown',
  'delete-line': 'workbench.settingsEditorKeyDeleteLine',
  'insert-blank-line': 'workbench.settingsEditorKeyInsertBlankLine',
  undo: 'workbench.settingsEditorKeyUndo',
  redo: 'workbench.settingsEditorKeyRedo',
  'select-next-occurrence': 'workbench.settingsEditorKeySelectNextOccurrence',
  'select-all-occurrences': 'workbench.settingsEditorKeySelectAllOccurrences',
  'select-line': 'workbench.settingsEditorKeySelectLine',
  'expand-selection': 'workbench.settingsEditorKeyExpandSelection',
  'add-cursor-above': 'workbench.settingsEditorKeyAddCursorAbove',
  'add-cursor-below': 'workbench.settingsEditorKeyAddCursorBelow',
  'undo-selection': 'workbench.settingsEditorKeyUndoSelection',
  'redo-selection': 'workbench.settingsEditorKeyRedoSelection',
  'jump-to-bracket': 'workbench.settingsEditorKeyJumpToBracket',
  'cursor-syntax-left': 'workbench.settingsEditorKeyCursorSyntaxLeft',
  'cursor-syntax-right': 'workbench.settingsEditorKeyCursorSyntaxRight',
  'select-syntax-left': 'workbench.settingsEditorKeySelectSyntaxLeft',
  'select-syntax-right': 'workbench.settingsEditorKeySelectSyntaxRight',
  fold: 'workbench.settingsEditorKeyFold',
  unfold: 'workbench.settingsEditorKeyUnfold',
  'fold-all': 'workbench.settingsEditorKeyFoldAll',
  'unfold-all': 'workbench.settingsEditorKeyUnfoldAll',
  'toggle-word-wrap': 'workbench.settingsEditorKeyToggleWordWrap',
  'toggle-tab-focus-mode': 'workbench.settingsEditorKeyToggleTabFocusMode',
  cancel: 'workbench.settingsEditorKeyCancel',
}

interface WorkbenchKeymapSettingsProps {
  /** 正在录键的那个动作；录键时 Esc 是取消录键，不关设置（所以这个状态在对话框手里）。 */
  capturingAction: Nullable<WorkbenchKeyboardShortcutAction>
  conflicts: WorkbenchKeymapConflict[]
  /** 此刻生效的键：所选方案的默认键，叠上用户自己改过的。 */
  keymap: WorkbenchKeyboardShortcutMap
  preset: WorkbenchKeymapPresetId
  /** 所选方案的默认键：哪一项改过、「重置」回到哪里都看它。 */
  presetShortcuts: WorkbenchKeyboardShortcutMap
  /** 按哪个平台显示键；不给用当前宿主平台。 */
  platform?: string
  onCapturingActionChange: (action: Nullable<WorkbenchKeyboardShortcutAction>) => void
  onPresetChange: (preset: WorkbenchKeymapPresetId) => void
  onResetShortcut: (action: WorkbenchKeyboardShortcutAction) => void
  onSetShortcut: (action: WorkbenchKeyboardShortcutAction, shortcut: string) => void
}

/**
 * 设置里「快捷键」那一段：选键位方案，下面是全局快捷键——显示所选方案的默认键，每一项可以另录一个，
 * 「重置」回到所选方案的默认键。
 */
export function WorkbenchKeymapSettings({
  capturingAction,
  conflicts,
  keymap,
  preset,
  presetShortcuts,
  platform,
  onCapturingActionChange,
  onPresetChange,
  onResetShortcut,
  onSetShortcut,
}: WorkbenchKeymapSettingsProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const conflictedActions = new Set(conflicts.flatMap((conflict) => conflict.actions))

  function handleShortcutCapture(
    action: WorkbenchKeyboardShortcutAction,
    event: KeyboardEvent<HTMLButtonElement>
  ): void {
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      onCapturingActionChange(null)
      return
    }

    const shortcut = shortcutFromWorkbenchKeyboardEvent(event.nativeEvent, platform)
    if (!shortcut) return

    onSetShortcut(action, shortcut)
    onCapturingActionChange(null)
  }

  return (
    <div className={styles.workbenchSettingsSectionPanel}>
      {!!conflicts.length && (
        <div className={styles.workbenchSettingsWarning}>
          <WarningCircleIcon size={15} />
          <Text>{t('workbench.settingsShortcutConflict')}</Text>
        </div>
      )}
      <SettingRow
        title={t('workbench.settingsKeymapPreset')}
        description={t(PresetDescriptionKeys[preset])}
      >
        <Select<WorkbenchKeymapPresetId>
          size="sm"
          className={styles.workbenchSettingsSelectTrigger}
          value={preset}
          options={WORKBENCH_KEYMAP_PRESET_IDS.map((id) => ({
            value: id,
            label: PresetLabels[id],
            description: t(PresetDescriptionKeys[id]),
          }))}
          onChange={onPresetChange}
        />
      </SettingRow>
      <div className={styles.workbenchSettingsShortcutList}>
        {WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.map(({ action }) => {
          const shortcut = keymap[action]
          const isCapturing = capturingAction === action

          return (
            <div
              key={action}
              className={styles.workbenchSettingsShortcutRow}
              data-shortcut-action={action}
              data-conflict={conflictedActions.has(action)}
            >
              <div className={styles.workbenchSettingsShortcutMeta}>
                <Text className={styles.workbenchSettingsShortcutTitle}>
                  {t(ShortcutLabelKeys[action])}
                </Text>
                <Text tone="caption" className={styles.workbenchSettingsShortcutDescription}>
                  {t(ShortcutDescriptionKeys[action])}
                </Text>
              </div>
              <div className={styles.workbenchSettingsShortcutControls}>
                <button
                  type="button"
                  className={styles.workbenchSettingsShortcutCapture}
                  data-capturing={isCapturing}
                  onClick={() => onCapturingActionChange(action)}
                  onKeyDown={(event) => handleShortcutCapture(action, event)}
                >
                  {isCapturing
                    ? t('workbench.settingsShortcutRecording')
                    : shortcut
                      ? formatWorkbenchShortcutForPlatform(shortcut, platform)
                      : t('workbench.settingsShortcutUnassigned')}
                </button>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  disabled={shortcut === presetShortcuts[action]}
                  label={t('workbench.settingsShortcutReset')}
                  title={t('workbench.settingsShortcutReset')}
                  onClick={() => onResetShortcut(action)}
                >
                  <ArrowCounterClockwiseIcon size={14} />
                </IconButton>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 「编辑器按键」那一段标题下面的说明：各方案说的不一样（有没有与 Workbench 不同的键、Vim 先拿哪些键）。 */
export const WorkbenchEditorKeysDescriptionKeys: Record<WorkbenchKeymapPresetId, WorkbenchMessageKey> = {
  workbench: 'workbench.settingsEditorKeysDescription',
  vscode: 'workbench.settingsEditorKeysChangedDescription',
  jetbrains: 'workbench.settingsEditorKeysChangedDescription',
  vim: 'workbench.settingsEditorKeysVimDescription',
}

/**
 * 设置里「编辑器按键」那一段：编辑器命令在所选方案下各是哪几个键，只读。与 Workbench 方案不一样的，名字
 * 下面标着 Workbench 方案的键，换了方案一眼看得出变了哪些。
 */
export function WorkbenchEditorKeysSettings({
  preset,
  platform,
}: {
  preset: WorkbenchKeymapPresetId
  /** 按哪个平台列键；不给用当前宿主平台。 */
  platform?: string
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const formatChord = (chord: string): string => formatWorkbenchShortcutForPlatform(chord, platform)

  return (
    <div className={styles.workbenchSettingsSectionPanel}>
      <div className={styles.workbenchSettingsShortcutList}>
        {WORKBENCH_EDITOR_KEYMAP_COMMANDS.map((command) => {
          const chords = getWorkbenchEditorCommandChords(command, preset, platform)
          const workbenchChords = getWorkbenchEditorCommandChords(
            command,
            DEFAULT_WORKBENCH_KEYMAP_PRESET,
            platform
          )
          const changed = chords.join(' ') !== workbenchChords.join(' ')

          return (
            <div
              key={command}
              className={styles.workbenchSettingsShortcutRow}
              data-editor-command={command}
            >
              <div className={styles.workbenchSettingsShortcutMeta}>
                <Text className={styles.workbenchSettingsShortcutTitle}>
                  {t(EditorCommandLabelKeys[command])}
                </Text>
                {changed && (
                  <Text tone="caption" className={styles.workbenchSettingsShortcutDescription}>
                    {t('workbench.settingsEditorKeysWorkbenchKey', {
                      shortcut:
                        workbenchChords.map(formatChord).join(' / ')
                        || t('workbench.settingsShortcutUnassigned'),
                    })}
                  </Text>
                )}
              </div>
              <div className={styles.workbenchSettingsShortcutControls}>
                {chords.length > 0 ? (
                  chords.map((chord) => (
                    <WorkbenchSettingsPill key={chord}>{formatChord(chord)}</WorkbenchSettingsPill>
                  ))
                ) : (
                  <Text tone="caption">{t('workbench.settingsShortcutUnassigned')}</Text>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
