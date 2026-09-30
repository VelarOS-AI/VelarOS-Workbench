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
  getStandaloneWorkbenchManagedProvider,
  isStandaloneWorkbenchManagedProviderId,
  refreshStandaloneWorkbenchManagedModels,
  useStandaloneWorkbenchManagedModels,
} from '@renderer/runtime/standaloneWorkbenchManagedModels'
import {
  createStandaloneWorkbenchModelProviderOptions,
  createStandaloneWorkbenchProviderModelOptions,
  getStandaloneWorkbenchModelProviderPreset,
  listStandaloneWorkbenchVisibleModelProviderPresets,
} from '@renderer/runtime/standaloneWorkbenchModelCatalog'
import {
  selectStandaloneWorkbenchModel,
  selectStandaloneWorkbenchModelProvider,
  StandaloneWorkbenchCompletionDisabledOptionValue,
  type StandaloneWorkbenchModelConfig,
  updateStandaloneWorkbenchModelConfig,
  useStandaloneWorkbenchModelConfig,
} from '@renderer/runtime/standaloneWorkbenchModelConfig'

import { Result } from '@velaros-ai/core/result'
import type { ProviderModelCatalog } from '@velaros-ai/model/contracts'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
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
} from '@shared/contracts'
import type { WorkbenchAccountState } from '@shared/workbenchAccount'
import type {
  WorkbenchPermissionConfirmationMode as PermissionConfirmationMode,
  WorkbenchWebSearchEngine,
} from '@shared/workbenchConversation'
import type { WorkbenchManagedModelProvider } from '@shared/workbenchModel'
import type { WorkbenchUpdateChannel } from '@shared/workbenchUpdate'

import styles from '../../styles/workbenchPageStyles'
import { useTimerScope } from '../../support/genericHooks'

import { WorkbenchMemorySettings } from './WorkbenchMemorySettings'

type WorkbenchSettingsSectionId =
  | 'general'
  | 'editor'
  | 'ai'
  | 'system'

interface WorkbenchSettingsDialogProps {
  conflicts: WorkbenchKeymapConflict[]
  keymap: WorkbenchKeyboardShortcutMap
  locale: AppLocale
  open: boolean
  preferences: WorkbenchPreferences
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
  onResetAllShortcuts: () => void
  onResetPreferences: () => void
  onResetShortcut: (action: WorkbenchKeyboardShortcutAction) => void
  onSetShortcut: (action: WorkbenchKeyboardShortcutAction, shortcut: string) => void
}
const ShortcutLabelKeys: Record<WorkbenchKeyboardShortcutAction, WorkbenchMessageKey> = {
  'close-right-tool': 'workbench.settingsShortcutCloseRightTool',
  'command-palette': 'workbench.settingsShortcutCommandPalette',
  'find-in-files': 'workbench.settingsShortcutFindInFiles',
  'focus-left-editor-group': 'workbench.settingsShortcutFocusLeftEditorGroup',
  'focus-right-editor-group': 'workbench.settingsShortcutFocusRightEditorGroup',
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
  'find-in-files': 'workbench.settingsShortcutFindInFilesDescription',
  'focus-left-editor-group': 'workbench.settingsShortcutFocusLeftEditorGroupDescription',
  'focus-right-editor-group': 'workbench.settingsShortcutFocusRightEditorGroupDescription',
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

function SettingsSubsection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <section className={styles.workbenchSettingsGroup}>
      <header className={styles.workbenchSettingsGroupHeader}>
        <div className={styles.workbenchSettingsGroupCopy}>
          <Text className={styles.workbenchSettingsGroupTitle}>{title}</Text>
          <Text tone="caption">{description}</Text>
        </div>
        {!!action && <div className={styles.workbenchSettingsGroupAction}>{action}</div>}
      </header>
      {children}
    </section>
  )
}

export function WorkbenchSettingsDialog({
  conflicts,
  keymap,
  locale,
  open,
  preferences,
  project = null,
  onExitProject,
  onLocaleChange,
  onOpenChange,
  onPreferencesChange,
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
  const managedModelState = useStandaloneWorkbenchManagedModels()
  const managedModels = managedModelState.managedModels
  const selectedManagedProvider = getStandaloneWorkbenchManagedProvider(
    modelConfig.provider,
    managedModelState
  )
  const managedSelectionVisible =
    !isStandaloneWorkbenchManagedProviderId(modelConfig.provider) || !!selectedManagedProvider
  const visibleModelProviders = listStandaloneWorkbenchVisibleModelProviderPresets(managedModels)
  const modelProviderPreset =
    visibleModelProviders.find((provider) => provider.id === modelConfig.provider)
    ?? getStandaloneWorkbenchModelProviderPreset(modelConfig.provider)
  const modelProviderOptions = createStandaloneWorkbenchModelProviderOptions(
    managedModels,
    (provider) => t('workbench.settingsModelProviderDisabled', { provider })
  )
  const timers = useTimerScope('WorkbenchSettingsDialog')
  const [activeSection, setActiveSection] = useState<WorkbenchSettingsSectionId>('general')
  const [accountState, setAccountState] = useState<WorkbenchAccountState>({
    status: 'signed-out',
  })
  const [isLoadingAccount, setIsLoadingAccount] = useState(false)
  const [isChangingAccount, setIsChangingAccount] = useState(false)
  const [accountError, setAccountError] = useState<Nullable<string>>(null)
  const [capturingAction, setCapturingAction] =
    useState<Nullable<WorkbenchKeyboardShortcutAction>>(null)
  const [projectAiRules, setProjectAiRules] =
    useState<Nullable<WorkbenchProjectAiRulesResult>>(null)
  const [expandedProjectAiRulePath, setExpandedProjectAiRulePath] = useState<Nullable<string>>(null)
  const [isLoadingProjectAiRules, setIsLoadingProjectAiRules] = useState(false)
  const [providerModelCatalog, setProviderModelCatalog] =
    useState<Nullable<{
      catalog: ProviderModelCatalog
      managedProvider: WorkbenchManagedModelProvider | undefined
    }>>(null)
  const [isLoadingProviderModels, setIsLoadingProviderModels] = useState(false)
  const [providerModelCatalogError, setProviderModelCatalogError] =
    useState<Nullable<string>>(null)
  const [modelBaseURLDraft, setModelBaseURLDraft] = useState(modelConfig.baseURL)
  const [modelApiKeyDraft, setModelApiKeyDraft] = useState(modelConfig.apiKey)
  const dialogRef = useRef<HTMLDivElement>(null)
  const activeProviderModelCatalog = providerModelCatalog?.catalog.provider === modelConfig.provider
    && providerModelCatalog.managedProvider === selectedManagedProvider
    ? providerModelCatalog.catalog
    : null
  const modelOptions = createStandaloneWorkbenchProviderModelOptions(
    activeProviderModelCatalog?.models ?? [],
    [modelConfig.model, modelConfig.completionModel],
    !selectedManagedProvider
  )
  const completionModelOptions = [
    {
      value: StandaloneWorkbenchCompletionDisabledOptionValue,
      label: t('workbench.settingsAiCompletionModelNone'),
    },
    ...modelOptions,
  ]
  const selectedManagedProviderDisabled = !!selectedManagedProvider && !selectedManagedProvider.enabled
  const modelCatalogDescription = selectedManagedProviderDisabled
    ? t('workbench.settingsModelProviderDisabled', { provider: modelProviderPreset.label })
    : isLoadingProviderModels
    ? t('workbench.settingsModelCatalogLoading', { provider: modelProviderPreset.label })
    : activeProviderModelCatalog?.models.length
      ? t('workbench.settingsModelCatalogLoaded', {
          provider: modelProviderPreset.label,
          count: activeProviderModelCatalog.models.length,
        })
      : providerModelCatalogError
        ? !modelConfig.apiKey.trim()
          && !modelProviderPreset.apiKeyOptional
          && modelProviderPreset.validationKind !== 'openrouter-key'
          ? t('workbench.settingsModelCatalogNeedsKey', {
              provider: modelProviderPreset.label,
            })
          : t('workbench.settingsModelCatalogError', {
              provider: modelProviderPreset.label,
              error: providerModelCatalogError,
            })
        : t('workbench.settingsModelCatalogEmpty', { provider: modelProviderPreset.label })

  const sections = useMemo(
    () => [
      {
        id: 'general' as const,
        label: t('workbench.settingsGeneral'),
        description: t('workbench.settingsGeneralDescription'),
      },
      {
        id: 'editor' as const,
        label: t('workbench.settingsEditor'),
        description: t('workbench.settingsEditorGroupDescription'),
      },
      {
        id: 'ai' as const,
        label: t('workbench.settingsAi'),
        description: t('workbench.settingsAiDescription'),
      },
      {
        id: 'system' as const,
        label: t('workbench.settingsSystem'),
        description: t('workbench.settingsSystemDescription'),
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
    if (!open) return
    setModelBaseURLDraft(modelConfig.baseURL)
    setModelApiKeyDraft(modelConfig.apiKey)
  }, [modelConfig.apiKey, modelConfig.baseURL, modelConfig.provider, open])

  useEffect(() => {
    if (!open || activeSection !== 'general') return

    let active = true
    setIsLoadingAccount(true)
    setAccountError(null)
    void window.velarosWorkbenchAccount.getState()
      .then((state) => {
        if (active) setAccountState(state)
      })
      .catch((error: unknown) => {
        if (!active) return
        setAccountError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (active) setIsLoadingAccount(false)
      })
    const dispose = window.velarosWorkbenchAccount.onChanged((state) => {
      if (!active) return
      setAccountState(state)
      setAccountError(null)
    })
    return () => {
      active = false
      dispose()
    }
  }, [activeSection, open])

  useEffect(() => {
    if (!open || activeSection !== 'ai') {
      setIsLoadingProviderModels(false)
      return
    }

    let active = true
    setProviderModelCatalog(null)
    setProviderModelCatalogError(null)
    if (
      isStandaloneWorkbenchManagedProviderId(modelConfig.provider)
      && !selectedManagedProvider?.enabled
    ) {
      setIsLoadingProviderModels(false)
      return
    }
    setIsLoadingProviderModels(true)
    const lease = timers.after(300, () => {
      void window.velarosWorkbenchModel.listProviderModels({
        provider: modelConfig.provider,
        apiKey: modelConfig.apiKey,
        baseURL: modelConfig.baseURL,
        purpose: 'chat',
      }).then((catalog) => {
        if (!active) return
        setProviderModelCatalog({ catalog, managedProvider: selectedManagedProvider })
        setProviderModelCatalogError(catalog.error ?? null)
      }).catch((error: unknown) => {
        if (!active) return
        setProviderModelCatalogError(
          error instanceof Error ? error.message : String(error)
        )
      }).finally(() => {
        if (active) setIsLoadingProviderModels(false)
      })
    }, { label: 'workbench.settings.model-catalog' })

    return () => {
      active = false
      lease.cancel()
    }
  }, [
    activeSection,
    modelConfig.apiKey,
    modelConfig.baseURL,
    modelConfig.provider,
    open,
    selectedManagedProvider,
    timers,
  ])

  useEffect(() => {
    if (!open || activeSection !== 'ai') return
    void refreshStandaloneWorkbenchManagedModels().catch(() => undefined)
  }, [activeSection, open])

  useEffect(() => {
    if (
      managedModelState.status !== 'ready'
      || !isStandaloneWorkbenchManagedProviderId(modelConfig.provider)
      || selectedManagedProvider
    ) return
    selectStandaloneWorkbenchModelProvider('openrouter')
  }, [managedModelState.status, modelConfig.provider, selectedManagedProvider])

  useEffect(() => {
    if (
      !selectedManagedProvider
      || activeProviderModelCatalog?.provider !== modelConfig.provider
      || activeProviderModelCatalog.models.length === 0
    ) return
    const available = new Set(activeProviderModelCatalog.models.map((model) => model.id))
    const fallback =
      (selectedManagedProvider.defaultModel
        && available.has(selectedManagedProvider.defaultModel)
        ? selectedManagedProvider.defaultModel
        : undefined)
      ?? activeProviderModelCatalog.models[0]?.id
    if (!fallback) return
    const patch: Partial<StandaloneWorkbenchModelConfig> = {}
    if (!available.has(modelConfig.model)) patch.model = fallback
    if (modelConfig.completionModel && !available.has(modelConfig.completionModel)) {
      patch.completionModel = fallback
    }
    if (Object.keys(patch).length > 0) updateStandaloneWorkbenchModelConfig(patch)
  }, [
    activeProviderModelCatalog,
    modelConfig.completionModel,
    modelConfig.model,
    modelConfig.provider,
    selectedManagedProvider,
  ])

  useEffect(() => {
    setProjectAiRules(null)
    setExpandedProjectAiRulePath(null)
  }, [project?.rootPath])

  useEffect(() => {
    if (!open || activeSection !== 'ai') return

    void refreshProjectAiRules()
  }, [activeSection, open, refreshProjectAiRules])

  if (!open) return null

  function commitModelConnectionDrafts(): void {
    const patch: Partial<Pick<StandaloneWorkbenchModelConfig, 'apiKey' | 'baseURL'>> = {}
    if (modelBaseURLDraft !== modelConfig.baseURL) patch.baseURL = modelBaseURLDraft
    if (modelApiKeyDraft !== modelConfig.apiKey) patch.apiKey = modelApiKeyDraft
    if (Object.keys(patch).length > 0) updateStandaloneWorkbenchModelConfig(patch)
  }

  function commitModelBaseURLDraft(): void {
    if (modelBaseURLDraft === modelConfig.baseURL) return
    updateStandaloneWorkbenchModelConfig({ baseURL: modelBaseURLDraft })
  }

  function commitModelApiKeyDraft(): void {
    if (modelApiKeyDraft === modelConfig.apiKey) return
    updateStandaloneWorkbenchModelConfig({ apiKey: modelApiKeyDraft })
  }

  function handleModelConnectionDraftKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.currentTarget.blur()
  }

  function closeDialog(): void {
    commitModelConnectionDrafts()
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
        value: 'warm-paper',
        label: t('workbench.settingsThemeWarmPaper'),
        description: t('workbench.settingsThemeWarmPaperDescription'),
      },
      {
        value: 'midnight-blue',
        label: t('workbench.settingsThemeMidnightBlue'),
        description: t('workbench.settingsThemeMidnightBlueDescription'),
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
      </div>
    )
  }

  function renderProjectSection(): ReactElement {
    const projectTitle = project?.name ?? t('workbench.settingsProjectContextNoProject')
    const projectDescription = project?.rootPath
      ?? t('workbench.settingsProjectContextNoProjectDescription')

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow title={projectTitle} description={projectDescription}>
          {project && onExitProject && (
            <Button
              size="sm"
              variant="destructiveOutline"
              onClick={() => void onExitProject()}
            >
              <SignOutIcon size={14} />
              {t('workbench.settingsExitProjectAction')}
            </Button>
          )}
        </SettingRow>
      </div>
    )
  }

  async function changeAccount(action: 'sign-in' | 'sign-out'): Promise<void> {
    setIsChangingAccount(true)
    setAccountError(null)
    try {
      const state = action === 'sign-in'
        ? await window.velarosWorkbenchAccount.signIn()
        : await window.velarosWorkbenchAccount.signOut()
      setAccountState(state)
      if (action === 'sign-out') {
        await window.velarosWorkbenchProjectHub.returnToEntry()
        onOpenChange(false)
      }
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsChangingAccount(false)
    }
  }

  function renderAccountSection(): ReactElement {
    const signedIn = accountState.status === 'signed-in'
    const accountTitle = signedIn
      ? accountState.account.displayName
      : isLoadingAccount
        ? t('workbench.settingsAccountLoading')
        : t('workbench.settingsAccountSignedOut')
    const accountDescription = signedIn
      ? accountState.account.email
      : t('workbench.settingsAccountSignedOutDescription')

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow title={accountTitle} description={accountDescription}>
          <div className={styles.workbenchSettingsShortcutControls}>
            <Button
              size="sm"
              variant={signedIn ? 'destructiveOutline' : 'outline'}
              disabled={isLoadingAccount || isChangingAccount}
              onClick={() => void changeAccount(signedIn ? 'sign-out' : 'sign-in')}
            >
              {signedIn ? <SignOutIcon size={14} /> : <ArrowSquareOutIcon size={14} />}
              {isChangingAccount
                ? t('workbench.settingsAccountChanging')
                : signedIn
                  ? t('workbench.settingsAccountSignOutAction')
                  : t('workbench.settingsAccountSignInAction')}
            </Button>
          </div>
        </SettingRow>
        {!!accountError && (
          <Text tone="caption" className={styles.workbenchSettingsPluginError} role="alert">
            {t('workbench.settingsAccountError', { error: accountError })}
          </Text>
        )}
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
          title={t('workbench.settingsEditorWordWrap')}
          description={t('workbench.settingsEditorWordWrapHint', {
            shortcut: /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥Z' : 'Alt+Z',
          })}
        >
          <Switch
            checked={preferences.editorWordWrap}
            onCheckedChange={(editorWordWrap) => onPreferencesChange({ editorWordWrap })}
          />
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsEditorFormatOnSave')}
          description={t('workbench.settingsEditorFormatOnSaveHint')}
        >
          <Switch
            checked={preferences.editorFormatOnSave}
            onCheckedChange={(editorFormatOnSave) => onPreferencesChange({ editorFormatOnSave })}
          />
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsEditorPreviewTabs')}
          description={t('workbench.settingsEditorPreviewTabsHint')}
        >
          <Switch
            checked={preferences.editorPreviewTabs}
            onCheckedChange={(editorPreviewTabs) => onPreferencesChange({ editorPreviewTabs })}
          />
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
            value={managedSelectionVisible ? modelConfig.provider : undefined}
            options={modelProviderOptions}
            onChange={(providerId) => {
              if (!modelProviderOptions.some((option) => option.value === providerId && !option.disabled)) return
              const provider = visibleModelProviders.find((entry) => entry.id === providerId)
              selectStandaloneWorkbenchModelProvider(
                providerId,
                provider
                  ? {
                      model: provider.defaultModel,
                      completionModel: provider.completionModel,
                    }
                  : undefined
              )
            }}
          />
        </SettingRow>
        {managedSelectionVisible && modelProviderPreset.baseURLConfigurable && (
          <SettingRow
            title={t('workbench.settingsModelBaseUrl')}
            description={t('workbench.settingsModelBaseUrlDescription')}
          >
            <Input
              size="sm"
              type="url"
              autoComplete="url"
              spellCheck={false}
              value={modelBaseURLDraft}
              placeholder={t('workbench.settingsModelBaseUrlPlaceholder')}
              onChange={(event) => setModelBaseURLDraft(event.currentTarget.value)}
              onBlur={commitModelBaseURLDraft}
              onKeyDown={handleModelConnectionDraftKeyDown}
            />
          </SettingRow>
        )}
        {managedSelectionVisible && (
          <>
            <SettingRow
              title={t('workbench.settingsModelName')}
              description={modelCatalogDescription}
            >
              <Select
                size="sm"
                className={styles.workbenchSettingsSelectTrigger}
                value={modelConfig.model}
                options={modelOptions}
                disabled={selectedManagedProviderDisabled}
                searchable={modelOptions.length > 12}
                searchPlaceholder={t('workbench.settingsModelSearchPlaceholder')}
                emptyMessage={t('workbench.settingsModelSearchEmpty')}
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
                value={
                  modelConfig.completionModel || StandaloneWorkbenchCompletionDisabledOptionValue
                }
                options={completionModelOptions}
                disabled={selectedManagedProviderDisabled}
                searchable={completionModelOptions.length > 12}
                searchPlaceholder={t('workbench.settingsModelSearchPlaceholder')}
                emptyMessage={t('workbench.settingsModelSearchEmpty')}
                onChange={(model) =>
                  selectStandaloneWorkbenchModel(modelConfig.provider, model, 'completion')
                }
              />
            </SettingRow>
          </>
        )}
        {managedSelectionVisible && !modelProviderPreset.apiKeyOptional && (
          <SettingRow
            title={t('workbench.settingsModelApiKey')}
            description={t('workbench.settingsModelApiKeyDescription')}
          >
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              value={modelApiKeyDraft}
              placeholder={t('workbench.settingsModelApiKeyPlaceholder')}
              onChange={(event) => setModelApiKeyDraft(event.currentTarget.value)}
              onBlur={commitModelApiKeyDraft}
              onKeyDown={handleModelConnectionDraftKeyDown}
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
          title={t('workbench.settingsUpdateChannel')}
          description={t('workbench.settingsUpdateChannelDescription')}
        >
          <Select<WorkbenchUpdateChannel>
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={updateState.channel}
            options={[
              { value: 'stable', label: t('workbench.settingsUpdateChannelStable') },
              { value: 'beta', label: t('workbench.settingsUpdateChannelBeta') },
              { value: 'canary', label: t('workbench.settingsUpdateChannelPreview') },
            ]}
            onChange={(channel) => void window.velarosWorkbenchUpdate.setChannel(channel)}
          />
        </SettingRow>
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

  function renderGeneralSection(): ReactElement {
    return (
      <div
        className={`${styles.workbenchSettingsSectionPanel} ${styles.workbenchSettingsCombinedPanel}`}
      >
        <SettingsSubsection
          title={t('workbench.settingsProject')}
          description={t('workbench.settingsProjectDescription')}
        >
          {renderProjectSection()}
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsAccount')}
          description={t('workbench.settingsAccountDescription')}
        >
          {renderAccountSection()}
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsAppearance')}
          description={t('workbench.settingsAppearanceDescription')}
          action={(
            <IconButton
              size="icon-sm"
              variant="outline"
              label={t('workbench.settingsResetAppearance')}
              title={t('workbench.settingsResetAppearance')}
              onClick={onResetPreferences}
            >
              <ArrowCounterClockwiseIcon size={14} />
            </IconButton>
          )}
        >
          {renderAppearanceSection()}
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsLanguage')}
          description={t('workbench.settingsLanguageDescription')}
        >
          {renderLanguageSection()}
        </SettingsSubsection>
      </div>
    )
  }

  function renderEditorGroup(): ReactElement {
    return (
      <div
        className={`${styles.workbenchSettingsSectionPanel} ${styles.workbenchSettingsCombinedPanel}`}
      >
        <SettingsSubsection
          title={t('workbench.settingsEditor')}
          description={t('workbench.settingsEditorDescription')}
        >
          {renderEditorSection()}
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsKeymap')}
          description={t('workbench.settingsKeymapDescription')}
          action={(
            <IconButton
              size="icon-sm"
              variant="outline"
              label={t('workbench.settingsResetKeymap')}
              title={t('workbench.settingsResetKeymap')}
              onClick={onResetAllShortcuts}
            >
              <ArrowCounterClockwiseIcon size={14} />
            </IconButton>
          )}
        >
          {renderKeymapSection()}
        </SettingsSubsection>
      </div>
    )
  }

  /**
   * 访问权限：Agent 动手前要不要先问你。
   *
   * 三档只调节**询问强度**，不是「能做什么」的开关：明确承诺等待确认的操作（实施计划、
   * 阻塞式动作卡）与破坏性命令在任何档位下都仍然逐次弹卡，判据住在 main 侧
   * WorkbenchToolConfirmationPolicy，界面只负责选档。
   */
  function renderPermissionsSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow
          title={t('workbench.settingsPermissionConfirmationMode')}
          description={t('workbench.settingsPermissionConfirmationModeDescription')}
        >
          <Select<PermissionConfirmationMode>
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={preferences.permissionConfirmationMode}
            options={[
              {
                value: 'standard-open',
                label: t('workbench.settingsPermissionModeStandardOpen'),
              },
              {
                value: 'ask-every-time',
                label: t('workbench.settingsPermissionModeAskEveryTime'),
              },
              {
                value: 'never-ask',
                label: t('workbench.settingsPermissionModeNeverAsk'),
              },
            ]}
            onChange={(permissionConfirmationMode) =>
              onPreferencesChange({ permissionConfirmationMode })}
          />
        </SettingRow>
        <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
          {t('workbench.settingsPermissionHardGateHint')}
        </Text>
        <SettingRow
          title={t('workbench.settingsAiChangesAutoOpen')}
          description={t('workbench.settingsAiChangesAutoOpenDescription')}
        >
          <Switch
            size="sm"
            checked={preferences.aiChangesAutoOpen}
            onCheckedChange={(aiChangesAutoOpen) => onPreferencesChange({ aiChangesAutoOpen })}
          />
        </SettingRow>
      </div>
    )
  }

  function renderAiSection(): ReactElement {
    return (
      <div
        className={`${styles.workbenchSettingsSectionPanel} ${styles.workbenchSettingsCombinedPanel}`}
      >
        <SettingsSubsection
          title={t('workbench.settingsModel')}
          description={t('workbench.settingsModelDescription')}
        >
          {renderModelSection()}
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsPermissions')}
          description={t('workbench.settingsPermissionsDescription')}
        >
          {renderPermissionsSection()}
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsWebSearch')}
          description={t('workbench.settingsWebSearchDescription')}
        >
          <div className={styles.workbenchSettingsSectionPanel}>
            <SettingRow
              title={t('workbench.settingsWebSearchEngine')}
              description={t('workbench.settingsWebSearchEngineDescription')}
            >
              <Select<WorkbenchWebSearchEngine>
                size="sm"
                className={styles.workbenchSettingsSelectTrigger}
                value={preferences.webSearchEngine}
                options={[
                  { value: 'google', label: 'Google' },
                  { value: 'bing', label: 'Bing' },
                ]}
                onChange={(webSearchEngine) => onPreferencesChange({ webSearchEngine })}
              />
            </SettingRow>
          </div>
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsMemory')}
          description={t('workbench.settingsMemoryDescription')}
        >
          <div className={styles.workbenchSettingsSectionPanel}>
            <SettingRow
              title={t('workbench.settingsMemoryEnabled')}
              description={t('workbench.settingsMemoryEnabledDescription')}
            >
              <Switch
                size="sm"
                checked={preferences.memoryEnabled}
                onCheckedChange={(memoryEnabled) => onPreferencesChange({ memoryEnabled })}
              />
            </SettingRow>
          </div>
          <WorkbenchMemorySettings projectRoot={project?.rootPath ?? null} />
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsAiRules')}
          description={t('workbench.settingsAiRulesDescription')}
        >
          {renderAiRulesSection()}
        </SettingsSubsection>
      </div>
    )
  }

  function renderSystemSection(): ReactElement {
    return (
      <div
        className={`${styles.workbenchSettingsSectionPanel} ${styles.workbenchSettingsCombinedPanel}`}
      >
        <SettingsSubsection
          title={t('workbench.settingsUpdates')}
          description={t('workbench.settingsUpdatesDescription')}
        >
          {renderUpdatesSection()}
        </SettingsSubsection>
        <SettingsSubsection
          title={t('workbench.settingsAdvanced')}
          description={t('workbench.settingsAdvancedDescription')}
        >
          {renderAdvancedSection()}
        </SettingsSubsection>
      </div>
    )
  }

  function renderActiveSection(): ReactElement {
    switch (activeSection) {
      case 'general': {
        return renderGeneralSection()
      }
      case 'editor': {
        return renderEditorGroup()
      }
      case 'ai': {
        return renderAiSection()
      }
      default: {
        return renderSystemSection()
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
