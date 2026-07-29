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
  CheckCircleIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'

import { isPresent } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import type {
  AppLocale,
  WorkbenchProjectAiRuleFile,
  WorkbenchProjectAiRulesResult,
} from '@velaros-ai/workbench/contracts'
import { useWorkbenchHostRuntime } from '@velaros-ai/workbench/host'
import type { WorkbenchMessageKey } from '@velaros-ai/workbench/i18n'
import { useWorkbenchI18n } from '@velaros-ai/workbench/i18n'
import {
  getDownloadableWorkbenchLanguagePlugins,
  type WorkbenchLanguagePluginDescriptor,
} from '@velaros-ai/workbench/models/editor/workbenchLanguagePluginModel'
import { useWorkbenchLanguagePluginRuntime } from '@velaros-ai/workbench/models/editor/WorkbenchLanguagePluginRuntimeProvider'
import type { WorkbenchKeymapConflict } from '@velaros-ai/workbench/models/layout/workbenchKeyboardShortcuts'
import {
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  formatWorkbenchShortcutForPlatform,
  shortcutFromWorkbenchKeyboardEvent,
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
} from '@velaros-ai/workbench/models/layout/workbenchKeyboardShortcuts'
import type {
  WorkbenchAccent,
  WorkbenchDensity,
  WorkbenchPreferences,
  WorkbenchThemeId,
} from '@velaros-ai/workbench/models/settings/workbenchPreferences'

import type {
  WorkbenchAgentModsOverview,
  WorkbenchAgentModStatus,
  WorkbenchAgentModSummary,
} from '../../../../../shared/workbenchAgentMods'
import styles from '../../styles/workbenchPageStyles'
import { useTimerScope } from '../../support/genericHooks'

type WorkbenchSettingsSectionId =
  | 'appearance'
  | 'editor'
  | 'ai-rules'
  | 'keymap'
  | 'language'
  | 'plugins'
  | 'mods'
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
  const languagePluginRuntime = useWorkbenchLanguagePluginRuntime()
  const timers = useTimerScope('WorkbenchSettingsDialog')
  const [activeSection, setActiveSection] = useState<WorkbenchSettingsSectionId>('appearance')
  const [capturingAction, setCapturingAction] =
    useState<Nullable<WorkbenchKeyboardShortcutAction>>(null)
  const [pluginQuery, setPluginQuery] = useState('')
  const [projectAiRules, setProjectAiRules] =
    useState<Nullable<WorkbenchProjectAiRulesResult>>(null)
  const [expandedProjectAiRulePath, setExpandedProjectAiRulePath] = useState<Nullable<string>>(null)
  const [isLoadingProjectAiRules, setIsLoadingProjectAiRules] = useState(false)
  const [modsOverview, setModsOverview] = useState<Nullable<WorkbenchAgentModsOverview>>(null)
  const [isLoadingModsOverview, setIsLoadingModsOverview] = useState(false)
  const [downloadedPluginIds, setDownloadedPluginIds] = useState<Set<string>>(() =>
    languagePluginRuntime.readDownloadedPluginIds()
  )
  const dialogRef = useRef<HTMLDivElement>(null)

  const sections = useMemo(
    () => [
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
        id: 'plugins' as const,
        label: t('workbench.settingsPlugins'),
        description: t('workbench.settingsPluginsDescription'),
      },
      {
        id: 'mods' as const,
        label: t('workbench.settingsMods'),
        description: t('workbench.settingsModsDescription'),
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

  const refreshModsOverview = useCallback(async (): Promise<void> => {
    setIsLoadingModsOverview(true)
    try {
      setModsOverview(await window.velarosWorkbenchAgentMods.getOverview())
    } catch {
      setModsOverview(null)
    } finally {
      setIsLoadingModsOverview(false)
    }
  }, [])

  const conflictedActions = useMemo(
    () => new Set(conflicts.flatMap((conflict) => conflict.actions)),
    [conflicts]
  )

  const pluginDescriptors = useMemo(() => getDownloadableWorkbenchLanguagePlugins(), [])
  const filteredPluginDescriptors = useMemo(() => {
    const query = pluginQuery.trim().toLowerCase()
    if (!query) return pluginDescriptors

    return pluginDescriptors.filter((plugin) =>
      [plugin.id, plugin.label, plugin.packageName, ...plugin.extensions, ...plugin.languages]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }, [pluginDescriptors, pluginQuery])

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

    void refreshModsOverview()
  }, [activeSection, open, refreshModsOverview])

  useEffect(() => {
    const refresh = (): void => {
      setDownloadedPluginIds(languagePluginRuntime.readDownloadedPluginIds())
    }

    return languagePluginRuntime.subscribe(refresh)
  }, [languagePluginRuntime])

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

  function installLanguagePlugin(plugin: WorkbenchLanguagePluginDescriptor): void {
    if (downloadedPluginIds.has(plugin.id)) return

    setDownloadedPluginIds(languagePluginRuntime.install(plugin.id))
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
    const themeOptions: Array<{ label: string; value: WorkbenchThemeId; description: string }> = [
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
              { value: 'compact', label: t('workbench.settingsDensityCompact') },
              { value: 'balanced', label: t('workbench.settingsDensityBalanced') },
              { value: 'comfortable', label: t('workbench.settingsDensityComfortable') },
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

  function renderEditorSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow title={t('workbench.settingsEditorFontSize')}>
          <div className={styles.workbenchSettingsRangeControl}>
            <input
              type="range"
              min={11}
              max={18}
              step={0.5}
              value={preferences.editorFontSize}
              onChange={(event) =>
                onPreferencesChange({ editorFontSize: +event.currentTarget.value })
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
                onPreferencesChange({ editorLineHeight: +event.currentTarget.value })
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
                onPreferencesChange({ localHistoryThrottleSeconds: +event.currentTarget.value })
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
      </div>
    )
  }

  function renderPluginsSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <div className={styles.workbenchSettingsPluginSearch}>
          <MagnifyingGlassIcon size={14} />
          <Input
            size="sm"
            value={pluginQuery}
            placeholder={t('workbench.settingsPluginsSearchPlaceholder')}
            onChange={(event) => setPluginQuery(event.currentTarget.value)}
          />
        </div>
        <div className={styles.workbenchSettingsPluginList}>
          {filteredPluginDescriptors.map((plugin) => {
            const installed = downloadedPluginIds.has(plugin.id)
            const installState = languagePluginRuntime.getInstallState(plugin.id)
            const installing = isPresent(installState) && installState.phase !== 'failed'
            const installingLabel =
              installing && isPresent(installState.percent)
                ? `${t('workbench.settingsPluginInstall')} · ${installState.percent}%`
                : `${t('workbench.settingsPluginInstall')} · ${plugin.label}`
            const actionLabel = installed
              ? `${t('workbench.settingsPluginInstalled')} · ${plugin.label}`
              : installing
                ? installingLabel
                : `${t('workbench.settingsPluginInstall')} · ${plugin.label}`

            return (
              <div key={plugin.id} className={styles.workbenchSettingsPluginRow}>
                <div className={styles.workbenchSettingsPluginIcon}>
                  <PlugsConnectedIcon size={15} />
                </div>
                <div className={styles.workbenchSettingsPluginMeta}>
                  <Text className={styles.workbenchSettingsPluginName}>{plugin.label}</Text>
                  <Text tone="caption" className={styles.workbenchSettingsPluginDescription}>
                    {plugin.extensions.join(', ')} · {plugin.packageName}
                  </Text>
                </div>
                <div className={styles.workbenchSettingsPluginActions}>
                  {installed ? (
                    <IconButton
                      label={actionLabel}
                      title={actionLabel}
                      variant="ghost"
                      size="icon-sm"
                      disabled
                      className={styles.workbenchSettingsPluginActionButton}
                      data-installed="true"
                    >
                      <CheckCircleIcon size={16} weight="fill" />
                    </IconButton>
                  ) : (
                    <IconButton
                      label={actionLabel}
                      title={actionLabel}
                      variant="ghost"
                      size="icon-sm"
                      disabled={installing}
                      data-installing={installing || undefined}
                      className={styles.workbenchSettingsPluginActionButton}
                      onClick={() => installLanguagePlugin(plugin)}
                    >
                      <DownloadSimpleIcon size={16} />
                    </IconButton>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  function modStatusLabel(status: WorkbenchAgentModStatus): string {
    switch (status) {
      case 'active': {
        return t('workbench.settingsModsStatusActive')
      }
      case 'partial': {
        return t('workbench.settingsModsStatusPartial')
      }
      case 'inactive': {
        return t('workbench.settingsModsStatusInactive')
      }
      default: {
        return t('workbench.settingsModsStatusRejected')
      }
    }
  }

  function modStatusTone(status: WorkbenchAgentModStatus): 'default' | 'success' | 'warning' {
    if (status === 'active') return 'success'
    if (status === 'inactive') return 'default'
    return 'warning'
  }

  function renderModRow(mod: WorkbenchAgentModSummary): ReactElement {
    return (
      <div key={`${mod.origin}:${mod.modId}`} className={styles.workbenchSettingsAiRuleItem}>
        <div className={styles.workbenchSettingsAiRuleRow}>
          <span className={styles.workbenchSettingsAiRuleIcon}>
            <PlugsConnectedIcon size={15} />
          </span>
          <span className={styles.workbenchSettingsAiRuleMain}>
            <span className={styles.workbenchSettingsAiRuleHeader}>
              <Text className={styles.workbenchSettingsAiRulePath}>
                {mod.modId}
                {mod.version ? ` · ${mod.version}` : ''}
              </Text>
              <span className={styles.workbenchSettingsAiRuleBadges}>
                <WorkbenchSettingsPill tone={modStatusTone(mod.status)}>
                  {modStatusLabel(mod.status)}
                </WorkbenchSettingsPill>
                {!!mod.absentAxes.length && (
                  <WorkbenchSettingsPill tone="warning">
                    {t('workbench.settingsModsAbsentAxes', { count: mod.absentAxes.length })}
                  </WorkbenchSettingsPill>
                )}
                {!!mod.unroutedAxes.length && (
                  <WorkbenchSettingsPill>
                    {t('workbench.settingsModsUnroutedAxes', { count: mod.unroutedAxes.length })}
                  </WorkbenchSettingsPill>
                )}
              </span>
            </span>
            {!!mod.reasons.length && (
              <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
                {mod.reasons.join('; ')}
              </Text>
            )}
          </span>
        </div>
      </div>
    )
  }

  function renderModsSection(): ReactElement {
    const mods = modsOverview?.mods ?? []
    const diagnostics = modsOverview?.diagnostics ?? []

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        {!!modsOverview?.degradedReason && (
          <div className={styles.workbenchSettingsWarning}>
            <WarningCircleIcon size={15} />
            <Text>
              {t('workbench.settingsModsDegraded', { reason: modsOverview.degradedReason })}
            </Text>
          </div>
        )}
        <SettingRow
          title={t('workbench.settingsAiRulesRefresh')}
          description={t('workbench.settingsModsReadOnlyHint')}
        >
          <IconButton
            size="icon-sm"
            variant="outline"
            className={styles.workbenchSettingsSmallIconButton}
            label={t('workbench.settingsAiRulesRefresh')}
            title={t('workbench.settingsAiRulesRefresh')}
            onClick={() => void refreshModsOverview()}
          >
            <ArrowCounterClockwiseIcon size={14} />
          </IconButton>
        </SettingRow>
        {isLoadingModsOverview && !modsOverview ? (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text>{t('workbench.settingsModsLoading')}</Text>
          </div>
        ) : mods.length ? (
          <div className={styles.workbenchSettingsAiRuleList}>
            {mods.map((mod) => renderModRow(mod))}
          </div>
        ) : (
          <div className={styles.workbenchSettingsAiRulesEmpty}>
            <Text className={styles.workbenchSettingsAiRulesEmptyTitle}>
              {t('workbench.settingsModsEmpty')}
            </Text>
            <Text tone="caption" className={styles.workbenchSettingsAiRulesEmptyDescription}>
              {t('workbench.settingsModsEmptyDescription')}
            </Text>
          </div>
        )}
        {!!diagnostics.length && (
          <div className={styles.workbenchSettingsStackedField}>
            <Text tone="caption" className={styles.workbenchSettingsRowTitle}>
              {t('workbench.settingsModsDiagnosticsTitle')}
            </Text>
            <div className={styles.workbenchSettingsAiRuleList}>
              {diagnostics.map((diagnostic, index) => (
                <div
                  key={`${diagnostic.code}:${diagnostic.modId ?? index}:${index}`}
                  className={styles.workbenchSettingsAiRuleItem}
                >
                  <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
                    {diagnostic.message}
                  </Text>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  function renderAdvancedSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
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

  function renderActiveSection(): ReactElement {
    switch (activeSection) {
      case 'appearance': {
        return renderAppearanceSection()
      }
      case 'editor': {
        return renderEditorSection()
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
