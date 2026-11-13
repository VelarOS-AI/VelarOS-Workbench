import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CodeIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  GearSixIcon,
  MonitorIcon,
  RobotIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  UserCircleIcon,
} from '@phosphor-icons/react'
import { useWorkbenchProductAnalytics } from '@renderer/hooks/useWorkbenchProductAnalytics'
import { useWorkbenchProviderModelCatalog } from '@renderer/hooks/useWorkbenchProviderModelCatalog'
import { useWorkbenchUpdate } from '@renderer/hooks/useWorkbenchUpdate'
import { useWorkbenchHostRuntime } from '@renderer/host/WorkbenchHostProvider'
import { formatWorkbenchEditorCommandHint } from '@renderer/models/editor/workbenchEditorKeymap'
import type {
  WorkbenchKeyboardShortcutAction,
  WorkbenchKeyboardShortcutMap,
  WorkbenchKeymapConflict,
} from '@renderer/models/layout/workbenchKeyboardShortcuts'
import type { WorkbenchKeymapPresetId } from '@renderer/models/layout/workbenchKeymapPresets'
import {
  WORKBENCH_EDITOR_FONT_SIZE_MAX,
  WORKBENCH_EDITOR_FONT_SIZE_MIN,
  WORKBENCH_EDITOR_FONT_SIZE_STEP,
  type WorkbenchPreferences,
} from '@renderer/models/workbenchPreferences'
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
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'
import { Log } from '@velaros-ai/velaros/core'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  type WorkbenchProjectAiRuleFile,
  type WorkbenchProjectAiRulesResult,
} from '@shared/contracts/workbench'
import type { WorkbenchAccountState } from '@shared/workbenchAccount'
import type {
  WorkbenchPermissionConfirmationMode as PermissionConfirmationMode,
  WorkbenchWebSearchEngine,
} from '@shared/workbenchConversation'
import type { WorkbenchUpdateChannel } from '@shared/workbenchUpdate'

import styles from '../../styles/workbenchPageStyles'
import { useTimerScope } from '../../support/genericHooks'

import { WorkbenchAppearanceSettings } from './WorkbenchAppearanceSettings'
import {
  WorkbenchEditorKeysDescriptionKeys,
  WorkbenchEditorKeysSettings,
  WorkbenchKeymapSettings,
} from './WorkbenchKeymapSettings'
import { WorkbenchMemorySettings } from './WorkbenchMemorySettings'
import {
  cleanWorkbenchModelCatalogError,
  getWorkbenchModelSignInReason,
} from './workbenchSettingsModelFeedback'
import {
  SettingRow,
  SettingsDisclosure,
  SettingsSlider,
  WorkbenchSettingsPill,
} from './WorkbenchSettingsParts'

type WorkbenchSettingsSectionId = 'appearance' | 'editor' | 'ai' | 'system' | 'account'

interface WorkbenchSettingsDialogProps {
  conflicts: WorkbenchKeymapConflict[]
  keymap: WorkbenchKeyboardShortcutMap
  /** 选的键位方案，和它的默认键（哪一项改过、「重置」回到哪里都看它）。 */
  keymapPreset: WorkbenchKeymapPresetId
  presetShortcuts: WorkbenchKeyboardShortcutMap
  locale: AppLocale
  open: boolean
  preferences: WorkbenchPreferences
  project?: LooseOptional<{
    name: string
    rootPath: string
  }>
  onCreateProjectAiRulesFile?: () => Promise<void>
  onExitProject?: () => Promise<boolean>
  onKeymapPresetChange: (preset: WorkbenchKeymapPresetId) => void
  onLocaleChange: (locale: AppLocale) => void | Promise<void>
  onOpenProjectFile?: (path: string) => void | Promise<void>
  onOpenChange: (open: boolean) => void
  onPreferencesChange: (patch: Partial<WorkbenchPreferences>) => void
  onResetAllShortcuts: () => void
  onResetPreferences: () => void
  onResetShortcut: (action: WorkbenchKeyboardShortcutAction) => void
  onSetShortcut: (action: WorkbenchKeyboardShortcutAction, shortcut: string) => void
}

function SettingsSubsection({
  title,
  description,
  action,
  children,
  defaultOpen = true,
  inline = false,
}: {
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  inline?: boolean
}): ReactElement {
  const content = (
    <section className={styles.workbenchSettingsGroup} aria-label={title}>
      {action && <div className={styles.workbenchSettingsGroupAction}>{action}</div>}
      {children}
    </section>
  )
  return inline ? (
    content
  ) : (
    <SettingsDisclosure title={title} description={description} defaultOpen={defaultOpen}>
      {content}
    </SettingsDisclosure>
  )
}

export function WorkbenchSettingsDialog({
  conflicts,
  keymap,
  keymapPreset,
  presetShortcuts,
  locale,
  open,
  preferences,
  project = null,
  onExitProject,
  onKeymapPresetChange,
  onLocaleChange,
  onOpenChange,
  onPreferencesChange,
  onResetAllShortcuts,
  onResetPreferences,
  onResetShortcut,
  onSetShortcut,
}: WorkbenchSettingsDialogProps): Nullable<ReactElement> {
  const { t, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const hostRuntime = useWorkbenchHostRuntime()
  const updateResult = useWorkbenchUpdate()
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
    visibleModelProviders.find((provider) => provider.id === modelConfig.provider) ??
    getStandaloneWorkbenchModelProviderPreset(modelConfig.provider)
  const modelProviderOptions = createStandaloneWorkbenchModelProviderOptions(
    managedModels,
    (provider) => t('workbench.settingsModelProviderDisabled', { provider }),
    modelConfig.provider
  )
  const timers = useTimerScope('WorkbenchSettingsDialog')
  const [activeSection, setActiveSection] = useState<WorkbenchSettingsSectionId>('appearance')
  const isAccountSectionActive = activeSection === 'account'
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches
  )
  const navigationId = useId()
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const [projectRulesExpanded, setProjectRulesExpanded] = useState(false)
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
  const {
    catalog: activeProviderModelCatalog,
    loading: isLoadingProviderModels,
    error: providerModelCatalogError,
  } = useWorkbenchProviderModelCatalog(
    modelConfig,
    selectedManagedProvider,
    open && activeSection === 'ai',
    managedModelState
  )
  const [modelBaseURLDraft, setModelBaseURLDraft] = useState(modelConfig.baseURL)
  const [modelApiKeyDraft, setModelApiKeyDraft] = useState(modelConfig.apiKey)
  const dialogRef = useRef<HTMLDivElement>(null)
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
  const selectedManagedProviderDisabled =
    !!selectedManagedProvider && !selectedManagedProvider.enabled
  const managedCatalogError =
    isStandaloneWorkbenchManagedProviderId(modelConfig.provider) && providerModelCatalogError
  const managedCatalogSignInReason = managedCatalogError
    ? getWorkbenchModelSignInReason(managedCatalogError)
    : null
  const modelCatalogDescription = selectedManagedProviderDisabled
    ? t('workbench.settingsModelProviderDisabled', { provider: modelProviderPreset.label })
    : isLoadingProviderModels
      ? t('workbench.settingsModelCatalogLoading', { provider: modelProviderPreset.label })
      : activeProviderModelCatalog?.models.length
        ? t('workbench.settingsModelCatalogLoaded', {
            provider: modelProviderPreset.label,
            count: activeProviderModelCatalog.models.length,
          })
        : managedCatalogError
          ? ''
          : providerModelCatalogError
            ? !modelConfig.apiKey.trim() &&
              !modelProviderPreset.apiKeyOptional &&
              modelProviderPreset.validationKind !== 'openrouter-key'
              ? t('workbench.settingsModelCatalogNeedsKey', {
                  provider: modelProviderPreset.label,
                })
              : t('workbench.settingsModelCatalogError', {
                  provider: modelProviderPreset.label,
                  error: cleanWorkbenchModelCatalogError(providerModelCatalogError),
                })
            : t('workbench.settingsModelCatalogEmpty', { provider: modelProviderPreset.label })

  const sections = [
    {
      id: 'appearance' as const,
      label: t('workbench.settingsAppearance'),
      description: t('workbench.settingsAppearanceDescription'),
      icon: MonitorIcon,
    },
    {
      id: 'editor' as const,
      label: t('workbench.settingsEditor'),
      description: t('workbench.settingsEditorGroupDescription'),
      icon: CodeIcon,
    },
    {
      id: 'ai' as const,
      label: t('workbench.settingsAi'),
      description: t('workbench.settingsAiDescription'),
      icon: RobotIcon,
    },
    {
      id: 'system' as const,
      label: t('workbench.settingsSystem'),
      description: t('workbench.settingsSystemDescription'),
      icon: GearSixIcon,
    },
    {
      id: 'account' as const,
      label: t('workbench.settingsAccount'),
      description: t('workbench.settingsAccountDescription'),
      icon: UserCircleIcon,
    },
  ]
  const selectedSection = sections.find((section) => section.id === activeSection) ?? sections[0]!

  useEffect(() => {
    const compactViewport = window.matchMedia('(max-width: 900px)')
    const updateLayout = (event: MediaQueryListEvent): void => setSidebarCollapsed(event.matches)
    compactViewport.addEventListener('change', updateLayout)
    return () => compactViewport.removeEventListener('change', updateLayout)
  }, [])

  useEffect(() => {
    if (!open) return
    dialogRef.current?.querySelector<HTMLHeadingElement>('#workbench-settings-title')?.focus()
  }, [activeSection, open])

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
    if (!open) return

    // A failed model request may invalidate the session after Settings first opens.
    // Read it again on Account navigation so the sign-in action is up to date.
    let active = true
    setIsLoadingAccount(true)
    setAccountError(null)
    void window.velarosWorkbenchAccount
      .getState()
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
  }, [isAccountSectionActive, open])

  useEffect(() => {
    if (!open || activeSection !== 'ai') return
    void refreshStandaloneWorkbenchManagedModels().catch(() => undefined)
  }, [activeSection, open])

  useEffect(() => {
    if (
      managedModelState.status !== 'ready' ||
      !isStandaloneWorkbenchManagedProviderId(modelConfig.provider) ||
      selectedManagedProvider
    )
      return
    selectStandaloneWorkbenchModelProvider('openrouter')
  }, [managedModelState.status, modelConfig.provider, selectedManagedProvider])

  useEffect(() => {
    if (
      !selectedManagedProvider ||
      activeProviderModelCatalog?.provider !== modelConfig.provider ||
      activeProviderModelCatalog.models.length === 0
    )
      return
    const available = new Set(activeProviderModelCatalog.models.map((model) => model.id))
    const fallback =
      (selectedManagedProvider.defaultModel && available.has(selectedManagedProvider.defaultModel)
        ? selectedManagedProvider.defaultModel
        : undefined) ?? activeProviderModelCatalog.models[0]?.id
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
    const projectRoot = project?.rootPath
    if (!open || activeSection !== 'ai' || !projectRulesExpanded || !projectRoot) {
      setIsLoadingProjectAiRules(false)
      return
    }

    let active = true
    const request = { projectRoot }
    async function refreshProjectAiRules(): Promise<void> {
      setIsLoadingProjectAiRules(true)
      try {
        const result = Result.unwrap(
          await hostRuntime.kernel.project.getWorkbenchProjectAiRules(request)
        )
        if (active) setProjectAiRules(result)
      } catch {
        if (active) setProjectAiRules(null)
      } finally {
        if (active) setIsLoadingProjectAiRules(false)
      }
    }
    void refreshProjectAiRules()
    return () => {
      active = false
    }
  }, [activeSection, hostRuntime, open, project?.rootPath, projectRulesExpanded])

  useEffect(() => {
    if (!open) return
    const persistDrafts = (): void => {
      const patch: Partial<StandaloneWorkbenchModelConfig> = {}
      if (modelBaseURLDraft !== modelConfig.baseURL) patch.baseURL = modelBaseURLDraft
      if (modelApiKeyDraft !== modelConfig.apiKey) patch.apiKey = modelApiKeyDraft
      if (Object.keys(patch).length) updateStandaloneWorkbenchModelConfig(patch)
    }
    window.addEventListener('beforeunload', persistDrafts)
    return () => window.removeEventListener('beforeunload', persistDrafts)
  }, [open, modelBaseURLDraft, modelApiKeyDraft, modelConfig.baseURL, modelConfig.apiKey])

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

  function reportSettingSaveFailure(titleKey: string, error: unknown): void {
    Log.tag('WorkbenchSettings').caught('Failed to save setting', error, { setting: titleKey })
    messageLatest.current.error({
      title: tLatest.current(titleKey),
      description: error instanceof Error ? error.message : String(error),
    })
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation()
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w' && !capturingAction) {
      event.preventDefault()
      closeDialog()
      return
    }
    if (event.key === 'Escape' && !capturingAction) {
      event.preventDefault()
      if (!sidebarCollapsed && window.matchMedia('(max-width: 760px)').matches) {
        setSidebarCollapsed(true)
        sidebarToggleRef.current?.focus()
      } else closeDialog()
    }
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

  function renderProjectSection(): ReactElement {
    const projectTitle = project?.name ?? t('workbench.settingsProjectContextNoProject')
    const projectDescription =
      project?.rootPath ?? t('workbench.settingsProjectContextNoProjectDescription')

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingRow title={projectTitle} description={projectDescription}>
          {project && onExitProject && (
            <Button size="sm" variant="destructiveOutline" onClick={() => void onExitProject()}>
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
      const state =
        action === 'sign-in'
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
    const account = accountState.status === 'signed-in' ? accountState.account : null
    const displayName =
      account?.displayName ||
      (isLoadingAccount
        ? t('workbench.settingsAccountLoading')
        : t('workbench.settingsAccountSignedOut'))
    const initials = account
      ? account.displayName
          .trim()
          .split(/\s+/u)
          .map((part) => part[0])
          .join('')
          .slice(0, 2)
          .toUpperCase() || account.email.slice(0, 2).toUpperCase()
      : null
    return (
      <div
        className={`${styles.workbenchSettingsSectionPanel} ${styles.workbenchSettingsCombinedPanel}`}
      >
        <SettingsDisclosure
          title={t('workbench.settingsAccountInfo')}
          description={t('workbench.settingsAccountInfoDescription')}
          defaultOpen
        >
          <div className={styles.workbenchSettingsAccountIdentity}>
            <span className={styles.workbenchSettingsAccountAvatar}>
              {initials || <UserCircleIcon size={28} />}
            </span>
            <strong>{displayName}</strong>
            {account && (
              <span className={styles.workbenchSettingsAccountEmail}>{account.email}</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={isLoadingAccount || isChangingAccount}
              onClick={() => void changeAccount(account ? 'sign-out' : 'sign-in')}
            >
              {account ? <SignOutIcon size={15} /> : <ArrowSquareOutIcon size={15} />}
              {isChangingAccount
                ? t('workbench.settingsAccountChanging')
                : account
                  ? t('workbench.settingsAccountSignOutAction')
                  : t('workbench.settingsAccountSignInAction')}
            </Button>
          </div>
          {!!accountError && (
            <Text className={styles.workbenchSettingsPluginError} role="alert">
              {t('workbench.settingsAccountError', { error: accountError })}
            </Text>
          )}
        </SettingsDisclosure>
        <SettingsSubsection
          title={t('workbench.settingsProject')}
          description={t('workbench.settingsProjectDescription')}
          defaultOpen={false}
        >
          {renderProjectSection()}
        </SettingsSubsection>
      </div>
    )
  }

  function renderEditorSection(): ReactElement {
    return (
      <div className={styles.workbenchSettingsSectionPanel}>
        <SettingsDisclosure
          title={t('workbench.settingsEditorDisplay')}
          description={t('workbench.settingsEditorDescription')}
          defaultOpen
        >
          <SettingRow title={t('workbench.settingsEditorFontSize')}>
            <div className={styles.workbenchSettingsRangeControl}>
              <SettingsSlider
                min={WORKBENCH_EDITOR_FONT_SIZE_MIN}
                max={WORKBENCH_EDITOR_FONT_SIZE_MAX}
                step={WORKBENCH_EDITOR_FONT_SIZE_STEP}
                value={preferences.editorFontSize}
                label={t('workbench.settingsEditorFontSize')}
                onChange={(value) => onPreferencesChange({ editorFontSize: value })}
              />
              <span>{preferences.editorFontSize}px</span>
            </div>
          </SettingRow>
          <SettingRow title={t('workbench.settingsEditorLineHeight')}>
            <div className={styles.workbenchSettingsRangeControl}>
              <SettingsSlider
                min={17}
                max={28}
                step={0.25}
                value={preferences.editorLineHeight}
                label={t('workbench.settingsEditorLineHeight')}
                onChange={(value) => onPreferencesChange({ editorLineHeight: value })}
              />
              <span>{preferences.editorLineHeight}px</span>
            </div>
          </SettingRow>
          <SettingRow
            title={t('workbench.settingsEditorWordWrap')}
            description={t('workbench.settingsEditorWordWrapHint', {
              shortcut: formatWorkbenchEditorCommandHint('toggle-word-wrap', keymapPreset),
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
        </SettingsDisclosure>
        <SettingsDisclosure
          title={t('workbench.settingsEditorMore')}
          description={t('workbench.settingsEditorMoreDescription')}
        >
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
              <SettingsSlider
                min={0}
                max={600}
                step={15}
                value={preferences.localHistoryThrottleSeconds}
                label={t('workbench.settingsLocalHistoryThrottle')}
                onChange={(value) => onPreferencesChange({ localHistoryThrottleSeconds: value })}
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
        </SettingsDisclosure>
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
          description={`${t('workbench.settingsModelProviderDescription')} ${modelCatalogDescription}`}
        >
          <Select
            size="sm"
            className={styles.workbenchSettingsSelectTrigger}
            value={modelConfig.provider}
            options={modelProviderOptions}
            onChange={(providerId) => {
              if (
                !modelProviderOptions.some(
                  (option) => option.value === providerId && !option.disabled
                )
              )
                return
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
        {managedCatalogError && (
          <div className={styles.workbenchSettingsModelFeedback} role="status">
            <span>
              {t(
                managedCatalogSignInReason === 'expired'
                  ? 'workbench.settingsModelSessionExpired'
                  : managedCatalogSignInReason === 'signed-out'
                    ? 'workbench.settingsModelSignInRequired'
                    : 'workbench.settingsModelCatalogUnavailable',
                { provider: modelProviderPreset.label }
              )}
            </span>
            {managedCatalogSignInReason && (
              <Button size="sm" variant="ghost" onClick={() => navigateToSection('account')}>
                {t('workbench.settingsModelOpenAccount')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refreshStandaloneWorkbenchManagedModels().catch(() => undefined)}
            >
              {t('workbench.settingsModelCatalogRetry')}
            </Button>
          </div>
        )}
        {managedSelectionVisible && (
          <>
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
        {(modelProviderPreset.baseURLConfigurable || !modelProviderPreset.apiKeyOptional) &&
          managedSelectionVisible && (
            <SettingsDisclosure
              key={modelConfig.provider}
              title={t('workbench.settingsConnection')}
              description={t('workbench.settingsConnectionDescription')}
              defaultOpen={!modelProviderPreset.apiKeyOptional && !modelConfig.apiKey.trim()}
            >
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
            </SettingsDisclosure>
          )}
      </div>
    )
  }

  function renderKeymapSection(): ReactElement {
    return (
      <WorkbenchKeymapSettings
        capturingAction={capturingAction}
        conflicts={conflicts}
        keymap={keymap}
        preset={keymapPreset}
        presetShortcuts={presetShortcuts}
        onCapturingActionChange={setCapturingAction}
        onPresetChange={onKeymapPresetChange}
        onResetShortcut={onResetShortcut}
        onSetShortcut={onSetShortcut}
      />
    )
  }

  function renderAdvancedSection(): ReactElement {
    const analyticsState = productAnalytics.state
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
            {analyticsState?.ok ? (
              <Switch
                checked={analyticsState.data.enabled}
                onCheckedChange={(enabled) => {
                  void productAnalytics.setEnabled(enabled).catch((error: unknown) => {
                    reportSettingSaveFailure('workbench.settingsProductAnalytics', error)
                  })
                }}
              />
            ) : analyticsState ? (
              <span role="alert">{analyticsState.error.message}</span>
            ) : (
              <span>{t('common.loading')}</span>
            )}
          </div>
        </SettingRow>
      </div>
    )
  }

  function renderUpdatesSection(): ReactElement {
    if (!updateResult || !updateResult.ok)
      return (
        <div className={styles.workbenchSettingsSectionPanel}>
          <SettingRow title={t('workbench.settingsAutomaticUpdates')}>
            {updateResult ? (
              <span role="alert">{updateResult.error.message}</span>
            ) : (
              <span>{t('common.loading')}</span>
            )}
          </SettingRow>
        </div>
      )
    const updateState = updateResult.data
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
    } else if (updateState.phase === 'verifying') {
      status = t('workbench.updateVerifying')
    } else if (updateState.phase === 'preparing') {
      status = t('workbench.updatePreparing')
    } else if (updateState.phase === 'retrying') {
      status = t('workbench.updateRetrying', { attempt: updateState.retryAttempt ?? 1 })
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
      updateState.phase === 'retrying' ||
      updateState.phase === 'verifying' ||
      updateState.phase === 'preparing' ||
      updateState.phase === 'paused' ||
      updateState.phase === 'downloaded'

    return (
      <div className={styles.workbenchSettingsSectionPanel}>
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
                variant="default"
                className={styles.workbenchSettingsUpdateRestart}
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
        <SettingsDisclosure
          title={t('workbench.settingsUpdatePreferences')}
          description={t('workbench.settingsUpdatePreferencesDescription')}
        >
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
              onChange={(channel) => {
                void window.velarosWorkbenchUpdate.setChannel(channel).catch((error: unknown) => {
                  reportSettingSaveFailure('workbench.settingsUpdateChannel', error)
                })
              }}
            />
          </SettingRow>
          <SettingRow
            title={t('workbench.settingsAutomaticUpdates')}
            description={t('workbench.settingsAutomaticUpdatesDescription')}
          >
            <Switch
              size="sm"
              checked={updateState.automaticDownloads}
              onCheckedChange={(enabled) => {
                void window.velarosWorkbenchUpdate
                  .setAutomaticDownloads(enabled)
                  .catch((error: unknown) => {
                    reportSettingSaveFailure('workbench.settingsAutomaticUpdates', error)
                  })
              }}
            />
          </SettingRow>
        </SettingsDisclosure>
      </div>
    )
  }

  function navigateToSection(section: WorkbenchSettingsSectionId): void {
    if (section !== activeSection) {
      commitModelConnectionDrafts()
      setCapturingAction(null)
      setProjectRulesExpanded(false)
      setActiveSection(section)
    }
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarCollapsed(true)
  }

  function renderSettingsNavigation(): ReactElement {
    return (
      <nav
        id={navigationId}
        className={styles.workbenchSettingsNavigation}
        aria-label={t('workbench.settingsNavigation')}
      >
        {sections.map((section, index) => {
          const SectionIcon = section.icon
          const account =
            section.id === 'account' && accountState.status === 'signed-in'
              ? accountState.account
              : null
          const accountInitials =
            account?.displayName
              .trim()
              .split(/\s+/u)
              .map((part) => part[0])
              .join('')
              .slice(0, 2)
              .toUpperCase() || account?.email.slice(0, 2).toUpperCase()
          return (
            <BubbleTooltip
              key={section.id}
              content={account?.displayName || section.label}
              disabled={!sidebarCollapsed}
              side="right"
            >
              <button
                type="button"
                className={styles.workbenchSettingsNavItem}
                aria-label={section.label}
                aria-current={activeSection === section.id ? 'page' : undefined}
                data-active={activeSection === section.id}
                data-secondary={index >= 4}
                onClick={() => navigateToSection(section.id)}
              >
                {account ? (
                  <span className={styles.workbenchSettingsNavAvatar} aria-hidden="true">
                    {accountInitials}
                  </span>
                ) : (
                  <SectionIcon size={18} aria-hidden="true" />
                )}
                <span className={styles.workbenchSettingsNavLabel}>
                  {account?.displayName || section.label}
                </span>
              </button>
            </BubbleTooltip>
          )
        })}
      </nav>
    )
  }

  function renderEditorGroup(): ReactElement {
    return (
      <div
        className={`${styles.workbenchSettingsSectionPanel} ${styles.workbenchSettingsCombinedPanel}`}
      >
        {renderEditorSection()}
        <SettingsDisclosure
          onExpandedChange={(expanded) => {
            if (!expanded) setCapturingAction(null)
          }}
          title={t('workbench.settingsKeymap')}
          description={t('workbench.settingsKeymapSummary')}
        >
          <SettingsSubsection
            inline
            title={t('workbench.settingsKeymap')}
            description={t('workbench.settingsKeymapDescription')}
            action={
              <IconButton
                size="icon-sm"
                variant="outline"
                label={t('workbench.settingsResetKeymap')}
                title={t('workbench.settingsResetKeymap')}
                onClick={onResetAllShortcuts}
              >
                <ArrowCounterClockwiseIcon size={14} />
              </IconButton>
            }
          >
            {renderKeymapSection()}
          </SettingsSubsection>
          <SettingsSubsection
            title={t('workbench.settingsEditorKeys')}
            description={t(WorkbenchEditorKeysDescriptionKeys[keymapPreset])}
            defaultOpen={false}
          >
            <WorkbenchEditorKeysSettings preset={keymapPreset} />
          </SettingsSubsection>
        </SettingsDisclosure>
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
              onPreferencesChange({ permissionConfirmationMode })
            }
          />
        </SettingRow>
        <SettingRow
          title={t('workbench.settingsWorkspaceSandbox')}
          description={t('workbench.settingsWorkspaceSandboxDescription')}
        >
          <Switch
            size="sm"
            checked={preferences.workspaceSandboxEnabled}
            onCheckedChange={(workspaceSandboxEnabled) =>
              onPreferencesChange({ workspaceSandboxEnabled })
            }
          />
        </SettingRow>
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
        <SettingsDisclosure
          title={t('workbench.settingsPermissions')}
          description={t('workbench.settingsPermissionsSummary')}
        >
          {renderPermissionsSection()}
        </SettingsDisclosure>
        <SettingsDisclosure
          title={t('workbench.settingsWebSearch')}
          description={t('workbench.settingsWebSearchSummary')}
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
        </SettingsDisclosure>
        <SettingsDisclosure
          title={t('workbench.settingsMemory')}
          description={t('workbench.settingsMemorySummary')}
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
        </SettingsDisclosure>
        <SettingsDisclosure
          onExpandedChange={setProjectRulesExpanded}
          title={t('workbench.settingsAiRules')}
          description={t('workbench.settingsAiRulesSummary')}
        >
          {renderAiRulesSection()}
        </SettingsDisclosure>
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
        <SettingsDisclosure
          title={t('workbench.settingsAdvanced')}
          description={t('workbench.settingsAdvancedDescription')}
        >
          {renderAdvancedSection()}
        </SettingsDisclosure>
      </div>
    )
  }

  function renderActiveSection(): ReactElement {
    switch (activeSection) {
      case 'appearance':
        return (
          <WorkbenchAppearanceSettings
            preferences={preferences}
            locale={locale}
            onPreferencesChange={onPreferencesChange}
            onLocaleChange={onLocaleChange}
            onResetPreferences={onResetPreferences}
          />
        )
      case 'editor':
        return renderEditorGroup()
      case 'ai':
        return renderAiSection()
      case 'system':
        return renderSystemSection()
      case 'account':
        return renderAccountSection()
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
        <div className={styles.workbenchSettingsBody} data-sidebar-collapsed={sidebarCollapsed}>
          <aside className={styles.workbenchSettingsSidebar}>
            <div className={styles.workbenchSettingsSidebarHeader}>
              <IconButton
                ref={sidebarToggleRef}
                variant="ghost"
                size="icon-sm"
                className={styles.workbenchSettingsSidebarToggle}
                label={t(
                  sidebarCollapsed
                    ? 'workbench.settingsExpandNavigation'
                    : 'workbench.settingsCollapseNavigation'
                )}
                aria-expanded={!sidebarCollapsed}
                aria-controls={navigationId}
                onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              >
                <SidebarSimpleIcon size={19} />
              </IconButton>
            </div>
            {renderSettingsNavigation()}
          </aside>
          {!sidebarCollapsed && (
            <button
              type="button"
              className={styles.workbenchSettingsSidebarBackdrop}
              aria-label={t('workbench.settingsCollapseNavigation')}
              onClick={() => {
                setSidebarCollapsed(true)
                sidebarToggleRef.current?.focus()
              }}
            />
          )}
          <div className={styles.workbenchSettingsContent} key={activeSection}>
            <section className={styles.workbenchSettingsPage} data-settings-page={activeSection}>
              <div className={styles.workbenchSettingsPageHeading}>
                <Title
                  level={1}
                  id="workbench-settings-title"
                  className={styles.workbenchSettingsPageTitle}
                  tabIndex={-1}
                >
                  {selectedSection.label}
                </Title>
                <Text className={styles.workbenchSettingsPageDescription}>
                  {selectedSection.description}
                </Text>
              </div>
              {renderActiveSection()}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
