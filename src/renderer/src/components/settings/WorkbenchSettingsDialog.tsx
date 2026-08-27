import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  PlugsConnectedIcon,
  SignOutIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useWorkbenchProductAnalytics } from '@renderer/hooks/useWorkbenchProductAnalytics'
import { useWorkbenchUpdate } from '@renderer/hooks/useWorkbenchUpdate'
import { useWorkbenchHostRuntime } from '@renderer/host'
import type { WorkbenchMessageKey } from '@renderer/i18n'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchKeymapConflict } from '@renderer/models/layout/workbenchKeyboardShortcuts'
import {
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  formatWorkbenchShortcutForPlatform,
  shortcutFromWorkbenchKeyboardEvent,
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
} from '@renderer/models/layout/workbenchKeyboardShortcuts'
import {
  WORKBENCH_EDITOR_FONT_SIZE_MAX,
  WORKBENCH_EDITOR_FONT_SIZE_MIN,
  WORKBENCH_EDITOR_FONT_SIZE_STEP,
  type WorkbenchAccent,
  type WorkbenchDensity,
  type WorkbenchPreferences,
  type WorkbenchThemeId,
} from '@renderer/models/settings/workbenchPreferences'
import {
  getStandaloneWorkbenchModelProviderPreset,
  StandaloneWorkbenchModelProviderPresets,
} from '@renderer/runtime/standaloneWorkbenchModelCatalog'
import {
  selectStandaloneWorkbenchModel,
  selectStandaloneWorkbenchModelProvider,
  updateStandaloneWorkbenchModelConfig,
  useStandaloneWorkbenchModelConfig,
} from '@renderer/runtime/standaloneWorkbenchModelConfig'

import { Result } from '@velaros-ai/core/result'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'

import type {
  AppLocale,
  WorkbenchProjectAiRuleFile,
  WorkbenchProjectAiRulesResult,
} from '@shared/contracts'

import type { WorkbenchModCatalog, WorkbenchModRecord } from '../../../../shared/workbenchAgentMods'
import type {
  WorkbenchResourcePluginCatalog,
  WorkbenchResourcePluginRecord,
} from '../../../../shared/workbenchResourcePlugins'
import styles from '../../styles/workbenchPageStyles'
import { useTimerScope } from '../../support/genericHooks'

type WorkbenchSettingsSectionId =
  | 'project'
  | 'appearance'
  | 'editor'
  | 'model'
  | 'ai-rules'
  | 'keymap'
  | 'language'
  | 'mods'
  | 'plugins'
  | 'updates'
  | 'advanced'

interface WorkbenchSettingsDialogProps {
  conflicts: WorkbenchKeymapConflict[]
  globalGitSshKeyPath: string
  keymap: WorkbenchKeyboardShortcutMap
  locale: AppLocale
  open: boolean
  preferences: WorkbenchPreferences
  projectGitSshKeyPath: string
  project?: LooseOptional<{
    name: string
    rootPath: string
  }>
  onCreateProjectAiRulesFile?: () => Promise<void>
  onExitProject?: () => Promise<boolean>
  onLocaleChange: (locale: AppLocale) => void | Promise<void>
  onOpenProjectFile?: (path: string) => void | Promise<void>
  onOpenChange: (open: boolean) => void
  onPreferencesChange: (patch: Partial<WorkbenchPreferences>) => void
  onProjectGitSshKeyPathChange: (value: string) => void
  onResetAllShortcuts: () => void
  onResetPreferences: () => void
  onResetShortcut: (action: WorkbenchKeyboardShortcutAction) => void
  onSetShortcut: (action: WorkbenchKeyboardShortcutAction, shortcut: string) => void
}
const ShortcutLabelKeys: Record<WorkbenchKeyboardShortcutAction, WorkbenchMessageKey> = {
  'close-right-tool': 'workbench.settingsShortcutCloseRightTool',
  'quick-open': 'workbench.settingsShortcutQuickOpen',
  'run-last-command': 'workbench.settingsShortcutRunLastCommand',
  'save-all': 'workbench.settingsShortcutSaveAll',
  'save-current': 'workbench.settingsShortcutSaveCurrent',
  'toggle-actions': 'workbench.settingsShortcutToggleActions',
  'toggle-changes': 'workbench.settingsShortcutToggleChanges',
  'toggle-problems': 'workbench.settingsShortcutToggleProblems',
}

const ShortcutDescriptionKeys: Record<WorkbenchKeyboardShortcutAction, WorkbenchMessageKey> = {
  'close-right-tool': 'workbench.settingsShortcutCloseRightToolDescription',
  'quick-open': 'workbench.settingsShortcutQuickOpenDescription',
  'run-last-command': 'workbench.settingsShortcutRunLastCommandDescription',
  'save-all': 'workbench.settingsShortcutSaveAllDescription',
  'save-current': 'workbench.settingsShortcutSaveCurrentDescription',
  'toggle-actions': 'workbench.settingsShortcutToggleActionsDescription',
  'toggle-changes': 'workbench.settingsShortcutToggleChangesDescription',
  'toggle-problems': 'workbench.settingsShortcutToggleProblemsDescription',
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}): ReactElement {
  return (
    <div className={styles.workbenchSettingsRow}>
      <div className={styles.workbenchSettingsRowMeta}>
        <Text className={styles.workbenchSettingsRowTitle}>{title}</Text>
        {!!description && (
          <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
            {description}
          </Text>
        )}
      </div>
      <div className={styles.workbenchSettingsRowControl}>{children}</div>
    </div>
  )
}

function WorkbenchSettingsPill({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: 'default' | 'success' | 'warning'
}): ReactElement {
  return (
    <span className={styles.workbenchSettingsPill} data-tone={tone}>
      {children}
    </span>
  )
}

export function WorkbenchSettingsDialog({
  conflicts,
  globalGitSshKeyPath,
  keymap,
  locale,
  open,
  preferences,
  projectGitSshKeyPath,
  project = null,
  onExitProject,
  onLocaleChange,
  onOpenChange,
  onPreferencesChange,
  onProjectGitSshKeyPathChange,
  onResetAllShortcuts,
  onResetPreferences,
  onResetShortcut,
  onSetShortcut,
}: WorkbenchSettingsDialogProps): Nullable<ReactElement> {
  const { t } = useWorkbenchI18n()
  const hostRuntime = useWorkbenchHostRuntime()
  const updateState = useWorkbenchUpdate()
  const productAnalytics = useWorkbenchProductAnalytics()
  const modelConfig = useStandaloneWorkbenchModelConfig()
  const modelProviderPreset = getStandaloneWorkbenchModelProviderPreset(modelConfig.provider)
  const modelProviderOptions = StandaloneWorkbenchModelProviderPresets.map((provider) => ({
    value: provider.id,
    label: provider.label,
    description: provider.description,
  }))
  const modelOptions = modelProviderPreset.models.map((model) => ({
    value: model,
    label: model,
  }))
  const timers = useTimerScope('WorkbenchSettingsDialog')
  const [activeSection, setActiveSection] = useState<WorkbenchSettingsSectionId>('project')
  const [capturingAction, setCapturingAction] =
    useState<Nullable<WorkbenchKeyboardShortcutAction>>(null)
  const [projectAiRules, setProjectAiRules] =
    useState<Nullable<WorkbenchProjectAiRulesResult>>(null)
  const [expandedProjectAiRulePath, setExpandedProjectAiRulePath] = useState<Nullable<string>>(null)
  const [isLoadingProjectAiRules, setIsLoadingProjectAiRules] = useState(false)
  const [pluginCatalog, setPluginCatalog] = useState<Nullable<WorkbenchResourcePluginCatalog>>(null)
  const [modCatalog, setModCatalog] = useState<Nullable<WorkbenchModCatalog>>(null)
  const [isLoadingMods, setIsLoadingMods] = useState(false)
  const [isLoadingPlugins, setIsLoadingPlugins] = useState(false)
  const [pluginQuery, setPluginQuery] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)

  const sections = useMemo(
    () => [
      {
        id: 'project' as const,
        label: t('workbench.settingsProject'),
        description: t('workbench.settingsProjectDescription'),
      },
      {
        id: 'appearance' as const,
        label: t('workbench.settingsAppearance'),
        description: t('workbench.settingsAppearanceDescription'),
      },
      {
        id: 'editor' as const,
        label: t('workbench.settingsEditor'),
        description: t('workbench.settingsEditorDescription'),
      },
      {
        id: 'model' as const,
        label: t('workbench.settingsModel'),
        description: t('workbench.settingsModelDescription'),
      },
      {
        id: 'ai-rules' as const,
        label: t('workbench.settingsAiRules'),
        description: t('workbench.settingsAiRulesDescription'),
      },
      {
        id: 'keymap' as const,
        label: t('workbench.settingsKeymap'),
        description: t('workbench.settingsKeymapDescription'),
      },
      {
        id: 'language' as const,
        label: t('workbench.settingsLanguage'),
        description: t('workbench.settingsLanguageDescription'),
      },
      {
        id: 'mods' as const,
        label: t('workbench.settingsMods'),
        description: t('workbench.settingsModsDescription'),
      },
      {
        id: 'plugins' as const,
        label: t('workbench.settingsPlugins'),
        description: t('workbench.settingsPluginsDescription'),
      },
      {
        id: 'updates' as const,
        label: t('workbench.settingsUpdates'),
        description: t('workbench.settingsUpdatesDescription'),
      },
      {
        id: 'advanced' as const,
        label: t('workbench.settingsAdvanced'),
        description: t('workbench.settingsAdvancedDescription'),
      },
    ],
    [t]
  )

  const refreshProjectAiRules = useCallback(async (): Promise<void> => {
    if (!project) {
      setProjectAiRules(null)
      return
    }

    setIsLoadingProjectAiRules(true)
    try {
      const result = Result.unwrap(
        await hostRuntime.kernel.project.getWorkbenchProjectAiRules({
          projectRoot: project.rootPath,
        })
      )
      setProjectAiRules(result)
    } catch {
      setProjectAiRules(null)
    } finally {
      setIsLoadingProjectAiRules(false)
    }
  }, [hostRuntime, project?.rootPath])

  const refreshPlugins = useCallback(async (): Promise<void> => {
    setIsLoadingPlugins(true)
    try {
      setPluginCatalog(await window.velarosWorkbenchResourcePlugins.list())
    } catch {
      setPluginCatalog(null)
    } finally {
      setIsLoadingPlugins(false)
    }
  }, [])

  const refreshMods = useCallback(async (): Promise<void> => {
    setIsLoadingMods(true)
    try {
      setModCatalog(await window.velarosWorkbenchAgentMods.list())
    } catch {
      setModCatalog(null)
    } finally {
      setIsLoadingMods(false)
    }
  }, [])

  const conflictedActions = useMemo(
    () => new Set(conflicts.flatMap((conflict) => conflict.actions)),
    [conflicts]
  )

  useEffect(() => {
    if (!open) {
      setCapturingAction(null)
      return
    }

    timers.nextFrame(() => dialogRef.current?.focus(), {
      label: 'workbench.settings.focus',
    })
  }, [open, timers])

  useEffect(() => {
    setProjectAiRules(null)
    setExpandedProjectAiRulePath(null)
  }, [project?.rootPath])

  useEffect(() => {
    if (!open || activeSection !== 'ai-rules') return

    void refreshProjectAiRules()
  }, [activeSection, open, refreshProjectAiRules])

  useEffect(() => {
    if (!open || activeSection !== 'mods') return

    void refreshMods()
    return window.velarosWorkbenchAgentMods.onChanged(setModCatalog)
  }, [activeSection, open, refreshMods])

  useEffect(() => {
    if (!open || activeSection !== 'plugins') return

    void refreshPlugins()
    return window.velarosWorkbenchResourcePlugins.onChanged(setPluginCatalog)
  }, [activeSection, open, refreshPlugins])

  if (!open) return null

  function closeDialog(): void {
    onOpenChange(false)
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation()
    if (event.key === 'Escape' && !capturingAction) {
      event.preventDefault()
      closeDialog()
    }
  }

  function handleShortcutCapture(
    action: WorkbenchKeyboardShortcutAction,
    event: KeyboardEvent<HTMLButtonElement>
  ): void {
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      setCapturingAction(null)
      return
    }

    const shortcut = shortcutFromWorkbenchKeyboardEvent(event.nativeEvent)
    if (!shortcut) return

    onSetShortcut(action, shortcut)
    setCapturingAction(null)
  }

  function renderProjectAiRuleRow(file: WorkbenchProjectAiRuleFile): ReactElement {
    const isExpanded = expandedProjectAiRulePath === file.relativePath

    return (
      <div key={file.relativePath} className={styles.workbenchSettingsAiRuleItem}>
        <button
          type="button"
          className={styles.workbenchSettingsAiRuleRow}
          aria-expanded={isExpanded}
          data-expanded={isExpanded}
          onClick={() =>
            setExpandedProjectAiRulePath((currentPath) =>
              currentPath === file.relativePath ? null : file.relativePath
            )
          }
        >
          <span className={styles.workbenchSettingsAiRuleIcon}>
            <FileTextIcon size={15} />
          </span>
          <span className={styles.workbenchSettingsAiRuleMain}>
            <span className={styles.workbenchSettingsAiRuleHeader}>
              <Text className={styles.workbenchSettingsAiRulePath}>{file.relativePath}</Text>
              <span className={styles.workbenchSettingsAiRuleBadges}>
                <WorkbenchSettingsPill>{file.sourceLabel}</WorkbenchSettingsPill>
              </span>
            </span>
          </span>
        </button>
        {isExpanded && <pre className={styles.workbenchSettingsAiRuleContent}>{file.content}</pre>}
      </div>
    )
  }

  function renderAppearanceSection(): ReactElement {
    const themeOptions: Array<{
      label: string
      value: WorkbenchThemeId
      description: string
    }> = [
      {
        value: 'light-modern',
        label: t('workbench.settingsThemeLightModern'),
        description: t('workbench.settingsThemeLightModernDescription'),
      },
      {
        value: 'dark-modern',
        label: t('workbench.settingsThemeDarkModern'),
        description: t('workbench.settingsThemeDarkModernDescription'),
      },
      {
        value: 'dark-plus',
        label: t('workbench.settingsThemeDarkPlus'),
        description: t('workbench.settingsThemeDarkPlusDescription'),
      },
      {
        value: 'light-plus',
        label: t('workbench.settingsThemeLightPlus'),
        description: t('workbench.settingsThemeLightPlusDescription'),
      },
    ]

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <div className={styles.workbenchSettingsStackedField}>
          <div className={styles.workbenchSettingsRowMeta}>
            <Text className={styles.workbenchSettingsRowTitle}>{t('workbench.settingsTheme')}</Text>
            <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
              {t('workbench.settingsThemeDescription')}
            </Text>
          </div>
          <div className={styles.workbenchSettingsThemeGrid}>
            {themeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={styles.workbenchSettingsThemeButton}
                data-active={preferences.theme === option.value}
                data-theme-option={option.value}
                onClick={() => onPreferencesChange({ theme: option.value })}
              >
                <span className={styles.workbenchSettingsThemeSwatch} aria-hidden="true" />
                <span className={styles.workbenchSettingsThemeCopy}>
                  <Text className={styles.workbenchSettingsThemeLabel}>{option.label}</Text>
                  <Text tone="caption" className={styles.workbenchSettingsThemeDescription}>
                    {option.description}
                  </Text>
                </span>
              </button>
            ))}
          </div>
        </div>
        <SettingRow title={t('workbench.settingsDensity')}>
          <Select<WorkbenchDensity>
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={preferences.density}
            options={[
              {
                value: 'compact',
                label: t('workbench.settingsDensityCompact'),
              },
              {
                value: 'balanced',
                label: t('workbench.settingsDensityBalanced'),
              },
              {
                value: 'comfortable',
                label: t('workbench.settingsDensityComfortable'),
              },
            ]}
            onChange={(density) => onPreferencesChange({ density })}
          />
        </SettingRow>
        <SettingRow title={t('workbench.settingsAccent')}>
          <Select<WorkbenchAccent>
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={preferences.accent}
            options={[
              { value: 'blue', label: t('workbench.settingsAccentBlue') },
              { value: 'teal', label: t('workbench.settingsAccentTeal') },
              { value: 'green', label: t('workbench.settingsAccentGreen') },
              { value: 'amber', label: t('workbench.settingsAccentAmber') },
              { value: 'orange', label: t('workbench.settingsAccentOrange') },
              { value: 'rose', label: t('workbench.settingsAccentRose') },
              { value: 'violet', label: t('workbench.settingsAccentViolet') },
              { value: 'slate', label: t('workbench.settingsAccentSlate') },
            ]}
            onChange={(accent) => onPreferencesChange({ accent })}
          />
        </SettingRow>
        <SettingRow title={t('workbench.settingsResetAppearance')}>
          <IconButton
            size="icon-sm"
            variant="outline"
            className={styles.workbenchSettingsSmallIconButton}
            label={t('workbench.settingsResetAppearance')}
            title={t('workbench.settingsResetAppearance')}
            onClick={onResetPreferences}
          >
            <ArrowCounterClockwiseIcon size={14} />
          </IconButton>
        </SettingRow>
      </div>
    )
  }

  function renderProjectSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        {project && (
          <div className={styles.workbenchSettingsStackedField}>
            <div className={styles.workbenchSettingsRowMeta}>
              <Text className={styles.workbenchSettingsRowTitle}>{project.name}</Text>
              <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
                {project.rootPath}
              </Text>
            </div>
          </div>
        )}
        <SettingRow
          title={t('workbench.settingsExitProject')}
          description={t('workbench.settingsExitProjectDescription')}
        >
          <Button
            size="sm"
            variant="destructiveOutline"
            disabled={!project || !onExitProject}
            onClick={() => void onExitProject?.()}
          >
            <SignOutIcon size={14} />
            {t('workbench.settingsExitProjectAction')}
          </Button>
        </SettingRow>
      </div>
    )
  }

  function renderEditorSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow title={t('workbench.settingsEditorFontSize')}>
          <div className={styles.workbenchSettingsRangeControl}>
            <input
              type="range"
              min={WORKBENCH_EDITOR_FONT_SIZE_MIN}
              max={WORKBENCH_EDITOR_FONT_SIZE_MAX}
              step={WORKBENCH_EDITOR_FONT_SIZE_STEP}
              value={preferences.editorFontSize}
              onChange={(event) =>
                onPreferencesChange({
                  editorFontSize: +event.currentTarget.value,
                })
              }
            />
            <span>{preferences.editorFontSize}px</span>
          </div>
        </SettingRow>
        <SettingRow title={t('workbench.settingsEditorLineHeight')}>
          <div className={styles.workbenchSettingsRangeControl}>
            <input
              type="range"
              min={17}
              max={28}
              step={0.25}
              value={preferences.editorLineHeight}
              onChange={(event) =>
                onPreferencesChange({
                  editorLineHeight: +event.currentTarget.value,
                })
              }
            />
            <span>{preferences.editorLineHeight}px</span>
          </div>
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsLocalHistoryThrottle')}
          description={t('workbench.settingsLocalHistoryThrottleHint')}
        >
          <div className={styles.workbenchSettingsRangeControl}>
            <input
              type="range"
              min={0}
              max={600}
              step={15}
              value={preferences.localHistoryThrottleSeconds}
              onChange={(event) =>
                onPreferencesChange({
                  localHistoryThrottleSeconds: +event.currentTarget.value,
                })
              }
            />
            <span>
              {preferences.localHistoryThrottleSeconds === 0
                ? t('workbench.settingsLocalHistoryThrottleEveryChange')
                : t('workbench.settingsLocalHistoryThrottleValue', {
                    seconds: preferences.localHistoryThrottleSeconds,
                  })}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsAiCompletionEnabled')}
          description={t('workbench.settingsAiCompletionEnabledHint')}
        >
          <Switch
            size="sm"
            checked={preferences.aiCompletionEnabled}
            onCheckedChange={(checked) => onPreferencesChange({ aiCompletionEnabled: checked })}
          />
        </SettingRow>
      </div>
    )
  }

  function renderAiRulesSection(): ReactElement {
    const files = projectAiRules?.files ?? []

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        {isLoadingProjectAiRules && !projectAiRules ? (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text>{t('workbench.settingsAiRulesLoading')}</Text>
          </div>
        ) : files.length ? (
          <div className={styles.workbenchSettingsAiRuleList}>
            {files.map((file) => renderProjectAiRuleRow(file))}
          </div>
        ) : (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text className={styles.workbenchSettingsAiRulesEmptyTitle}>
              {t('workbench.settingsAiRulesEmpty')}
            </Text>
            <Text tone="caption" className={styles.workbenchSettingsAiRulesEmptyDescription}>
              {t('workbench.settingsAiRulesEmptyDescription')}
            </Text>
          </div>
        )}
      </div>
    )
  }

  function renderModelSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow
          title={t('workbench.settingsModelProvider')}
          description={t('workbench.settingsModelProviderDescription')}
        >
          <Select
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={modelConfig.provider}
            options={modelProviderOptions}
            onChange={selectStandaloneWorkbenchModelProvider}
          />
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsModelName')}
          description={t('workbench.settingsModelNameDescription')}
        >
          <Select
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={modelConfig.model}
            options={modelOptions}
            onChange={(model) =>
              selectStandaloneWorkbenchModel(modelConfig.provider, model, 'agent')
            }
          />
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsAiCompletionModel')}
          description={t('workbench.settingsAiCompletionModelHint')}
        >
          <Select
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={modelConfig.completionModel}
            options={modelOptions}
            onChange={(model) =>
              selectStandaloneWorkbenchModel(modelConfig.provider, model, 'completion')
            }
          />
        </SettingRow>
        {!modelProviderPreset.apiKeyOptional && (
          <SettingRow
            title={t('workbench.settingsModelApiKey')}
            description={t('workbench.settingsModelApiKeyDescription')}
          >
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              value={modelConfig.apiKey}
              placeholder={t('workbench.settingsModelApiKeyPlaceholder')}
              onChange={(event) =>
                updateStandaloneWorkbenchModelConfig({
                  apiKey: event.currentTarget.value,
                })
              }
            />
          </SettingRow>
        )}
      </div>
    )
  }

  function renderKeymapSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        {!!conflicts.length && (
          <div className={styles.workbenchSettingsWarning}>
            <WarningCircleIcon size={15} />
            <Text>{t('workbench.settingsShortcutConflict')}</Text>
          </div>
        )}
        <SettingRow title={t('workbench.settingsResetKeymap')}>
          <IconButton
            size="icon-sm"
            variant="outline"
            className={styles.workbenchSettingsSmallIconButton}
            label={t('workbench.settingsResetKeymap')}
            title={t('workbench.settingsResetKeymap')}
            onClick={onResetAllShortcuts}
          >
            <ArrowCounterClockwiseIcon size={14} />
          </IconButton>
        </SettingRow>
        <div className={styles.workbenchSettingsShortcutList}>
          {WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.map((definition) => {
            const shortcut = keymap[definition.action]
            const isCapturing = capturingAction === definition.action
            const isDefault =
              shortcut === DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP[definition.action]
            const hasConflict = conflictedActions.has(definition.action)

            return (
              <div
                key={definition.action}
                className={styles.workbenchSettingsShortcutRow}
                data-conflict={hasConflict}
              >
                <div className={styles.workbenchSettingsShortcutMeta}>
                  <Text className={styles.workbenchSettingsShortcutTitle}>
                    {t(ShortcutLabelKeys[definition.action])}
                  </Text>
                  <Text tone="caption" className={styles.workbenchSettingsShortcutDescription}>
                    {t(ShortcutDescriptionKeys[definition.action])}
                  </Text>
                </div>
                <div className={styles.workbenchSettingsShortcutControls}>
                  <button
                    type="button"
                    className={styles.workbenchSettingsShortcutCapture}
                    data-capturing={isCapturing}
                    onClick={() => setCapturingAction(definition.action)}
                    onKeyDown={(event) => handleShortcutCapture(definition.action, event)}
                  >
                    {isCapturing
                      ? t('workbench.settingsShortcutRecording')
                      : formatWorkbenchShortcutForPlatform(shortcut)}
                  </button>
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    className={styles.workbenchSettingsSmallIconButton}
                    disabled={isDefault}
                    label={t('workbench.settingsShortcutReset')}
                    title={t('workbench.settingsShortcutReset')}
                    onClick={() => onResetShortcut(definition.action)}
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

  function renderLanguageSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow
          title={t('workbench.settingsWorkbenchLanguage')}
          description={t('workbench.settingsWorkbenchLanguageDescription')}
        >
          <Select<AppLocale>
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={locale}
            options={[
              { value: 'zh-CN', label: t('common.chinese') },
              { value: 'en-US', label: t('common.english') },
            ]}
            onChange={(nextLocale) => void onLocaleChange(nextLocale)}
          />
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsPrimaryLanguages')}
          description={t('workbench.settingsPrimaryLanguagesDescription')}
        >
          <div className={styles.workbenchSettingsShortcutControls}>
            <WorkbenchSettingsPill tone="success">VelarScript</WorkbenchSettingsPill>
            <WorkbenchSettingsPill>JS / TS / JSX</WorkbenchSettingsPill>
            <WorkbenchSettingsPill>Python</WorkbenchSettingsPill>
            <WorkbenchSettingsPill>Web</WorkbenchSettingsPill>
          </div>
        </SettingRow>
      </div>
    )
  }

  function pluginStatusLabel(plugin: WorkbenchResourcePluginRecord): string {
    switch (plugin.status) {
      case 'available':
        return t('workbench.settingsPluginStatusAvailable')
      case 'disabled':
        return t('workbench.settingsPluginStatusDisabled')
      case 'installing':
        return t('workbench.settingsPluginStatusInstalling', {
          progress: plugin.progress ?? 0,
        })
      case 'failed':
        return t('workbench.settingsPluginStatusFailed')
      default:
        return t('workbench.settingsPluginStatusMissing')
    }
  }

  async function installPlugin(plugin: WorkbenchResourcePluginRecord): Promise<void> {
    setPluginCatalog(await window.velarosWorkbenchResourcePlugins.install({ id: plugin.id }))
  }

  async function setPluginEnabled(
    plugin: WorkbenchResourcePluginRecord,
    enabled: boolean
  ): Promise<void> {
    setPluginCatalog(
      await window.velarosWorkbenchResourcePlugins.setEnabled({
        id: plugin.id,
        enabled,
      })
    )
  }

  function renderPluginRow(plugin: WorkbenchResourcePluginRecord): ReactElement {
    return (
      <div key={plugin.id} className={styles.workbenchSettingsPluginRow}>
        <span className={styles.workbenchSettingsPluginIcon}>
          <PlugsConnectedIcon size={16} />
        </span>
        <div className={styles.workbenchSettingsPluginMeta}>
          <Text className={styles.workbenchSettingsPluginName}>
            CodeGraph{plugin.version ? ` · ${plugin.version}` : ''}
          </Text>
          <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
            {t('workbench.settingsPluginCodeGraphDescription')}
          </Text>
          {!!plugin.error && (
            <Text tone="caption" className={styles.workbenchSettingsPluginError}>
              {plugin.error}
            </Text>
          )}
        </div>
        <div className={styles.workbenchSettingsPluginActions}>
          <WorkbenchSettingsPill
            tone={
              plugin.status === 'available'
                ? 'success'
                : plugin.status === 'failed'
                  ? 'warning'
                  : 'default'
            }
          >
            {pluginStatusLabel(plugin)}
          </WorkbenchSettingsPill>
          {plugin.installed ? (
            <Switch
              size="sm"
              checked={plugin.enabled}
              disabled={plugin.status === 'installing'}
              onCheckedChange={(enabled) => void setPluginEnabled(plugin, enabled)}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!plugin.canInstall || plugin.status === 'installing'}
              onClick={() => void installPlugin(plugin)}
            >
              <DownloadSimpleIcon size={14} />
              {plugin.status === 'failed'
                ? t('workbench.settingsPluginRetry')
                : t('workbench.settingsPluginInstall')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  async function setModEnabled(mod: WorkbenchModRecord, enabled: boolean): Promise<void> {
    setModCatalog(
      await window.velarosWorkbenchAgentMods.setEnabled({
        id: mod.id,
        enabled,
      })
    )
  }

  function renderModsSection(): ReactElement {
    const mod = modCatalog?.mods.find((candidate) => candidate.id === 'velaros.agent-engines')
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <Text tone="caption" className={styles.workbenchSettingsPluginSharedHint}>
          {t('workbench.settingsModsHint')}
        </Text>
        {isLoadingMods && !modCatalog ? (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text>{t('workbench.settingsModsLoading')}</Text>
          </div>
        ) : mod ? (
          <div className={styles.workbenchSettingsPluginList}>
            <div className={styles.workbenchSettingsPluginRow}>
              <span className={styles.workbenchSettingsPluginIcon}>
                <PlugsConnectedIcon size={16} />
              </span>
              <div className={styles.workbenchSettingsPluginMeta}>
                <Text className={styles.workbenchSettingsPluginName}>
                  {t('workbench.settingsAgentEnginesModTitle')} · {mod.version}
                </Text>
                <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
                  {t('workbench.settingsAgentEnginesModDescription')}
                </Text>
              </div>
              <div className={styles.workbenchSettingsPluginActions}>
                <Switch
                  size="sm"
                  checked={mod.enabled}
                  onCheckedChange={(enabled) => void setModEnabled(mod, enabled)}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text>{t('workbench.settingsModsEmpty')}</Text>
          </div>
        )}
      </div>
    )
  }

  function renderPluginsSection(): ReactElement {
    const plugins = (pluginCatalog?.plugins ?? []).filter((plugin) =>
      `${plugin.id} CodeGraph`.toLowerCase().includes(pluginQuery.trim().toLowerCase())
    )
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <div className={styles.workbenchSettingsPluginToolbar}>
          <div className={styles.workbenchSettingsPluginSearch}>
            <SearchField
              size="sm"
              value={pluginQuery}
              placeholder={t('workbench.settingsPluginSearch')}
              onChange={(event) => setPluginQuery(event.currentTarget.value)}
            />
          </div>
          <IconButton
            size="icon-sm"
            variant="outline"
            className={styles.workbenchSettingsSmallIconButton}
            label={t('workbench.settingsAiRulesRefresh')}
            title={t('workbench.settingsAiRulesRefresh')}
            onClick={() => void refreshPlugins()}
          >
            <ArrowCounterClockwiseIcon size={14} />
          </IconButton>
        </div>
        <Text tone="caption" className={styles.workbenchSettingsPluginSharedHint}>
          {t('workbench.settingsPluginSharedHint')}
        </Text>
        {isLoadingPlugins && !pluginCatalog ? (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text>{t('workbench.settingsPluginsLoading')}</Text>
          </div>
        ) : plugins.length ? (
          <div className={styles.workbenchSettingsPluginList}>
            {plugins.map((plugin) => renderPluginRow(plugin))}
          </div>
        ) : (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text>{t('workbench.settingsPluginsEmpty')}</Text>
          </div>
        )}
      </div>
    )
  }

  function renderAdvancedSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow
          title={t('workbench.settingsProductAnalytics')}
          description={t('workbench.settingsProductAnalyticsDescription')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconButton
              label={t('workbench.settingsProductAnalyticsDetails')}
              size="icon-sm"
              variant="ghost"
              onClick={productAnalytics.openDetails}
            >
              <ArrowSquareOutIcon size={16} />
            </IconButton>
            <Switch
              checked={productAnalytics.enabled}
              onCheckedChange={productAnalytics.setEnabled}
            />
          </div>
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsGitSshKeyPath')}
          description={t('workbench.settingsGitSshKeyPathDescription')}
        >
          <Input
            size="sm"
            value={projectGitSshKeyPath}
            placeholder={
              globalGitSshKeyPath
                ? t('workbench.settingsGitSshKeyPathGlobalPlaceholder', {
                    path: globalGitSshKeyPath,
                  })
                : t('workbench.settingsGitSshKeyPathPlaceholder')
            }
            onChange={(event) => onProjectGitSshKeyPathChange(event.currentTarget.value)}
          />
        </SettingRow>
      </div>
    )
  }

  function renderUpdatesSection(): ReactElement {
    const targetVersion = updateState.targetVersion ?? ''
    let status = t('workbench.settingsUpdateIdle')
    if (updateState.phase === 'checking') status = t('workbench.settingsCheckingForUpdates')
    else if (updateState.phase === 'available') {
      status = t('workbench.settingsUpdateAvailable', {
        version: targetVersion,
      })
    } else if (updateState.phase === 'downloading') {
      status = t('workbench.updateDownloading', {
        percent: Math.round(updateState.percent ?? 0),
        version: targetVersion,
      })
    } else if (updateState.phase === 'paused') {
      status = t('workbench.updatePaused', {
        percent: Math.round(updateState.percent ?? 0),
        version: targetVersion,
      })
    } else if (updateState.phase === 'downloaded') {
      status = t('workbench.settingsUpdateDownloaded', {
        version: targetVersion,
      })
    } else if (updateState.phase === 'error') {
      status = t('workbench.settingsUpdateError', {
        error: updateState.error ?? '',
      })
    }
    const checkDisabled =
      updateState.phase === 'checking' ||
      updateState.phase === 'downloading' ||
      updateState.phase === 'paused' ||
      updateState.phase === 'downloaded'

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow
          title={t('workbench.settingsAutomaticUpdates')}
          description={t('workbench.settingsAutomaticUpdatesDescription')}
        >
          <Switch
            size="sm"
            checked={updateState.automaticDownloads}
            onCheckedChange={(enabled) =>
              void window.velarosWorkbenchUpdate.setAutomaticDownloads(enabled)
            }
          />
        </SettingRow>
        <SettingRow title={t('workbench.settingsCurrentVersion')} description={status}>
          <div className={styles.workbenchSettingsPluginActions}>
            <WorkbenchSettingsPill>{updateState.currentVersion}</WorkbenchSettingsPill>
            {updateState.phase === 'available' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void window.velarosWorkbenchUpdate.download()}
              >
                <DownloadSimpleIcon size={14} />
                {t('workbench.settingsDownloadUpdate')}
              </Button>
            )}
            {updateState.phase === 'downloaded' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void window.velarosWorkbenchUpdate.restart()}
              >
                {t('workbench.settingsRestartToUpdate')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={checkDisabled}
              onClick={() => void window.velarosWorkbenchUpdate.check()}
            >
              <ArrowCounterClockwiseIcon size={14} />
              {updateState.phase === 'checking'
                ? t('workbench.settingsCheckingForUpdates')
                : t('workbench.settingsCheckForUpdates')}
            </Button>
          </div>
        </SettingRow>
      </div>
    )
  }

  function renderActiveSection(): ReactElement {
    switch (activeSection) {
      case 'project': {
        return renderProjectSection()
      }
      case 'appearance': {
        return renderAppearanceSection()
      }
      case 'editor': {
        return renderEditorSection()
      }
      case 'model': {
        return renderModelSection()
      }
      case 'ai-rules': {
        return renderAiRulesSection()
      }
      case 'keymap': {
        return renderKeymapSection()
      }
      case 'language': {
        return renderLanguageSection()
      }
      case 'plugins': {
        return renderPluginsSection()
      }
      case 'mods': {
        return renderModsSection()
      }
      case 'updates': {
        return renderUpdatesSection()
      }
      default: {
        return renderAdvancedSection()
      }
    }
  }

  return (
    <div
      className={styles.workbenchSettingsOverlay}
      role="presentation"
      onKeyDown={handleDialogKeyDown}
    >
      <div
        ref={dialogRef}
        className={styles.workbenchSettingsDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workbench-settings-title"
        tabIndex={-1}
      >
        <header className={styles.workbenchSettingsHeader}>
          <div className={styles.workbenchSettingsTitleGroup}>
            <Title
              level={4}
              className={styles.workbenchSettingsTitle}
              id="workbench-settings-title"
            >
              {t('workbench.settingsTitle')}
            </Title>
          </div>
          <IconButton
            variant="ghost"
            size="icon-sm"
            className={styles.workbenchSettingsCloseButton}
            label={t('common.cancel')}
            title={t('common.cancel')}
            onClick={closeDialog}
          >
            <XIcon size={16} />
          </IconButton>
        </header>
        <div className={styles.workbenchSettingsBody}>
          <nav
            className={styles.workbenchSettingsSidebar}
            aria-label={t('workbench.settingsTitle')}
          >
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={styles.workbenchSettingsNavItem}
                data-active={activeSection === section.id}
                onClick={() => setActiveSection(section.id)}
              >
                <span className={styles.workbenchSettingsNavCopy}>
                  <span className={styles.workbenchSettingsNavLabel}>{section.label}</span>
                  <span className={styles.workbenchSettingsNavDescription}>
                    {section.description}
                  </span>
                </span>
              </button>
            ))}
          </nav>
          <section className={styles.workbenchSettingsContent}>{renderActiveSection()}</section>
        </div>
      </div>
    </div>
  )
}
