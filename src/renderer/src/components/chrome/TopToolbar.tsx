import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { BugIcon, CheckIcon, GearSixIcon, PlayIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import { describeWorkbenchRunConfiguration } from '@renderer/models/commands/workbenchNamedRunConfigurations'
import { hasWorkbenchGitHead } from '@renderer/models/git/workbenchGitTopBarModel'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { AnchoredPopover } from '@velaros-ai/ui/primitives/overlays/AnchoredPopover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'
import { isEmpty, toNullable } from '@velaros-ai/velaros/core'

import { type SystemWorkspaceGitSummary } from '@shared/contracts/system'

import { type WorkbenchTopRunControl } from '../../hooks/useWorkbenchTopRunControl'
import styles from '../../styles/workbenchPageStyles'
import { WorkbenchGitBranchControl } from '../git/WorkbenchGitBranchControl'

import { handleWorkbenchMenuKeyDown } from './WorkbenchContextMenu'

export interface TopToolbarProps {
  gitWorkspaceRoot: string
  gitSummary: Nullable<SystemWorkspaceGitSummary>
  onGitRefresh: () => Promise<void>
  gitSshKeyPath?: string
  hasUnsavedOpenTabs: boolean
  onRepositoryChanged: () => void | Promise<void>
  onOpenGitCommitTool: () => void
  onOpenSettings: () => void
  topRun: WorkbenchTopRunControl
  isRunningCommand: boolean
  hasActiveRunCommand: boolean
}

export function WorkbenchTopLeading({
  gitWorkspaceRoot,
  gitSummary,
  onGitRefresh,
  gitSshKeyPath,
  hasUnsavedOpenTabs,
  onRepositoryChanged,
  onOpenGitCommitTool,
}: Pick<
  TopToolbarProps,
  | 'gitWorkspaceRoot'
  | 'gitSummary'
  | 'onGitRefresh'
  | 'gitSshKeyPath'
  | 'hasUnsavedOpenTabs'
  | 'onRepositoryChanged'
  | 'onOpenGitCommitTool'
>): Nullable<ReactElement> {
  // 分离的 HEAD 上控件照样在：从分支菜单才能切回分支。
  const gitControlReady = !!gitSummary?.repository && hasWorkbenchGitHead(gitSummary.status)
  if (!gitControlReady) return null

  return (
    <div className={styles.topGitControl}>
      {/* 分支、拉取、推送、同步都在这一个控件里：按钮上是分支和落后 / 领先的提交数，点开是面板。 */}
      <WorkbenchGitBranchControl
        workspaceRoot={gitWorkspaceRoot}
        summary={gitSummary}
        gitSshKeyPath={gitSshKeyPath}
        hasUnsavedOpenTabs={hasUnsavedOpenTabs}
        onRefresh={onGitRefresh}
        onRepositoryChanged={onRepositoryChanged}
        onOpenCommitTool={onOpenGitCommitTool}
      />
    </div>
  )
}

export function WorkbenchSettingsAction({
  onOpenSettings,
}: Pick<TopToolbarProps, 'onOpenSettings'>): ReactElement {
  const { t } = useWorkbenchI18n()
  const settingsLabel = t('workbench.settingsTitle')
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={styles.rightToolButton}
      aria-label={settingsLabel}
      onClick={onOpenSettings}
    >
      <GearSixIcon size={17} />
    </Button>
  )
}

export function WorkbenchTopTrailing({
  topRun,
  isRunningCommand,
  hasActiveRunCommand,
}: Pick<TopToolbarProps, 'topRun' | 'isRunningCommand' | 'hasActiveRunCommand'>): ReactElement {
  const { t } = useWorkbenchI18n()
  const runCommandLabel = t('workbench.runCommand')
  // ▶ 指着一个 Node 程序时旁边多一个「调试」。
  const debugLabel =
    topRun.canDebugActiveConfiguration && topRun.activeConfiguration
      ? t('workbench.debuggerDebugConfiguration', { name: topRun.activeConfiguration.name })
      : null

  return (
    <>
      <WorkbenchRunAction
        topRun={topRun}
        label={runCommandLabel}
        placeholder={t('workbench.runConfigurationPlaceholder')}
        className={styles.topRunButton}
        tooltipSide="left"
        isRunningCommand={isRunningCommand}
        hasActiveRunCommand={hasActiveRunCommand}
      />
      {!!debugLabel && (
        <WorkbenchTopIconAction
          tooltip={debugLabel}
          label={debugLabel}
          tooltipSide="left"
          onClick={topRun.debug}
        >
          <BugIcon size={17} />
        </WorkbenchTopIconAction>
      )}
    </>
  )
}

function WorkbenchRunAction({
  topRun,
  label,
  placeholder,
  className,
  tooltipSide,
  isRunningCommand,
  hasActiveRunCommand,
}: {
  topRun: WorkbenchTopRunControl
  label: string
  placeholder: string
  className?: string
  tooltipSide: 'bottom' | 'left' | 'right' | 'top'
  isRunningCommand: boolean
  hasActiveRunCommand: boolean
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const [duplicateRunDialogOpen, setDuplicateRunDialogOpen] = useState(false)
  const [draftCommand, setDraftCommand] = useState('')
  const activeOption = useMemo(
    () => toNullable(topRun.options.find((option) => option.value === topRun.activeCommandKey)),
    [topRun.activeCommandKey, topRun.options]
  )
  // 一次性 runner（程序化/agent）占用只影响转圈图标，不禁用侧边栏按钮；
  // 用户命令走可并行的 PTY 运行卡，相同命令由确认框裁决重新运行还是新开。
  const oneShotBusy = isRunningCommand || hasActiveRunCommand
  const { activeConfiguration } = topRun
  const activeLabel = activeConfiguration
    ? activeConfiguration.name
    : topRun.isConfigured
      ? topRun.configuredCommand
      : (activeOption?.label ?? topRun.activeCommand)
  const activeDescription = activeConfiguration
    ? describeWorkbenchRunConfiguration(activeConfiguration)
    : topRun.isConfigured
      ? t('workbench.runConfiguredCommand')
      : activeOption?.description?.trim()
  const configureHint = t('workbench.runRightClickToConfigure')
  const tooltipTitle = activeLabel || placeholder
  const actionLabel = [label, tooltipTitle, activeDescription, configureHint]
    .filter((value) => !!value)
    .join(' · ')

  function openConfig(): void {
    setDraftCommand(topRun.configuredCommand || topRun.activeCommand || '')
    setMenuOpen(true)
  }

  function handleRunContextMenu(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    openConfig()
  }

  function handleRunClick(): void {
    if (!topRun.activeCommand) {
      openConfig()
      return
    }

    setMenuOpen(false)
    if (topRun.isActiveCommandRunning) {
      setDuplicateRunDialogOpen(true)
      return
    }
    topRun.run()
  }

  function handleRestartActiveCommand(): void {
    setDuplicateRunDialogOpen(false)
    topRun.restartActiveCommand()
  }

  function handleStartNewRun(): void {
    setDuplicateRunDialogOpen(false)
    topRun.run()
  }

  function handleConfigSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (topRun.configureCommand(draftCommand)) setMenuOpen(false)
  }

  function handlePickOption(key: string): void {
    if (topRun.selectCommand(key)) setMenuOpen(false)
  }

  function handleResetAuto(): void {
    if (!topRun.configureCommand('')) return
    setDraftCommand('')
    setMenuOpen(false)
  }

  function handlePickConfiguration(configurationId: string): void {
    if (topRun.selectConfiguration(configurationId)) setMenuOpen(false)
  }

  function handleRunConfiguration(configurationId: string): void {
    setMenuOpen(false)
    topRun.runConfiguration(configurationId)
  }

  function handleDebugConfiguration(configurationId: string): void {
    setMenuOpen(false)
    topRun.debugConfiguration(configurationId)
  }

  function handleEditConfigurations(): void {
    setMenuOpen(false)
    topRun.editConfigurations()
  }

  /**
   * 菜单里的方向键（与工作台里别的菜单同一套：↑ ↓ 在各项之间走，Home / End 到头尾）。菜单里还有一个输入框：
   * 在它里面 Home / End 是在那段文字里走，↑ ↓ 从它出发到它前面、后面的那一项。
   */
  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const input = event.target instanceof HTMLInputElement ? event.target : null
    if (!input) {
      handleWorkbenchMenuKeyDown(event)
      return
    }

    event.stopPropagation()
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ]
    const after = (button: HTMLButtonElement): boolean =>
      !!(input.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)
    const target =
      event.key === 'ArrowDown' ? buttons.find(after) : buttons.findLast((button) => !after(button))
    if (!target) return
    event.preventDefault()
    target.focus()
  }

  // 菜单收起时焦点还在菜单里（它马上要卸掉）或者已经没了着落，就还给打开之前的地方；焦点已经到了别处的不动它。
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const commandInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!menuOpen) return undefined
    const previous = document.activeElement
    return () => {
      const focused = document.activeElement
      const stranded =
        !focused ||
        focused === document.body ||
        !focused.isConnected ||
        !!menuPanelRef.current?.contains(focused)
      if (stranded && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [menuOpen])

  return (
    <>
      <AnchoredPopover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        // 焦点给命令输入框：浮层先挂出来、摆好位置才看得见，输入框上的 autoFocus 赶在那之前，落不上。
        onOpenAutoFocus={() => commandInputRef.current?.focus({ preventScroll: true })}
        className={styles.runActionPopover}
        side="left"
        align="start"
        sideOffset={8}
        widthStrategy="content"
        anchor={({ getAnchorProps }) => (
          <BubbleTooltip
            // 菜单开着时不出悬停说明：指针还停在 ▶ 上，说明会盖住菜单最上面的几行。
            disabled={menuOpen}
            content={
              <span className={styles.runActionTooltip}>
                <span className={styles.runActionTooltipTitle}>{tooltipTitle}</span>
                {!!activeDescription && (
                  <span className={styles.runActionTooltipDescription}>{activeDescription}</span>
                )}
                <span className={styles.runActionTooltipDescription}>{configureHint}</span>
              </span>
            }
            ariaLabel={actionLabel}
            side={tooltipSide}
            sideOffset={6}
            delayDuration={80}
          >
            <IconButton
              {...getAnchorProps<HTMLButtonElement>({ disabled: true, onClick: handleRunClick })}
              variant="ghost"
              size="icon-sm"
              className={className}
              label={actionLabel}
              disabled={false}
              onContextMenu={handleRunContextMenu}
            >
              {oneShotBusy ? (
                <SpinnerGapIcon size={17} className={styles.spinIcon} />
              ) : (
                <PlayIcon size={17} weight="regular" />
              )}
            </IconButton>
          </BubbleTooltip>
        )}
      >
        <div
          ref={menuPanelRef}
          className={styles.runActionPanel}
          role="menu"
          aria-label={placeholder}
          onKeyDown={handleMenuKeyDown}
        >
          {/* 用户自己建的运行配置排在最前面：点一行让 ▶ 指着它，行尾的 ▶ 直接跑这一份；Node 程序还有一个调试。 */}
          {!isEmpty(topRun.namedConfigurations) && (
            <div className={styles.runActionSectionLabel}>{t('workbench.runConfigurations')}</div>
          )}
          {topRun.namedConfigurations.map((configuration) => {
            const active = configuration.id === activeConfiguration?.id
            const description = describeWorkbenchRunConfiguration(configuration)
            return (
              <div key={configuration.id} className={styles.runActionNamedRow}>
                <button
                  type="button"
                  className={`${styles.runActionOption} ${active ? styles.runActionOptionActive : ''}`}
                  data-active={active}
                  role="menuitemradio"
                  aria-checked={active}
                  title={description}
                  onClick={() => handlePickConfiguration(configuration.id)}
                >
                  <span className={styles.runActionOptionMeta}>
                    <span className={styles.runActionOptionLabel}>{configuration.name}</span>
                    <span className={styles.runActionOptionDescription}>{description}</span>
                  </span>
                  {active && (
                    <CheckIcon size={13} weight="bold" className={styles.runActionOptionCheck} />
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.runActionRowButton}
                  title={t('workbench.runConfigurationRunNow')}
                  aria-label={t('workbench.runConfigurationRunNow')}
                  onClick={() => handleRunConfiguration(configuration.id)}
                >
                  <PlayIcon size={12} weight="fill" />
                </button>
                {configuration.type === 'node' && (
                  <button
                    type="button"
                    role="menuitem"
                    className={`${styles.runActionRowButton} ${styles.runActionRowDebugButton}`}
                    title={t('workbench.runConfigurationDebugNow')}
                    aria-label={t('workbench.runConfigurationDebugNow')}
                    onClick={() => handleDebugConfiguration(configuration.id)}
                  >
                    <BugIcon size={13} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            className={styles.runActionEdit}
            role="menuitem"
            onClick={handleEditConfigurations}
          >
            {t('workbench.runConfigurationsEdit')}
          </button>
          <form className={styles.runActionConfig} onSubmit={handleConfigSubmit}>
            <span className={styles.runActionConfigLabel}>
              {t('workbench.runConfigureCommand')}
            </span>
            <div className={styles.runActionConfigRow}>
              <Input
                ref={commandInputRef}
                size="sm"
                className={styles.runActionConfigInput}
                value={draftCommand}
                placeholder={t('workbench.runConfigureCommandPlaceholder')}
                spellCheck={false}
                onChange={(event) => setDraftCommand(event.target.value)}
              />
              <button
                type="submit"
                className={styles.runActionConfigSave}
                disabled={!draftCommand.trim()}
              >
                {t('workbench.runConfigureSave')}
              </button>
            </div>
          </form>
          {!isEmpty(topRun.options) && (
            <div className={styles.runActionSectionLabel}>{t('workbench.runDetectedCommands')}</div>
          )}
          {topRun.options.map((option) => {
            // ▶ 指着一份运行配置时，命令文本碰巧一样的这一行不算选中。
            const active = !activeConfiguration && option.value === topRun.activeCommandKey
            return (
              <button
                key={option.value}
                type="button"
                className={`${styles.runActionOption} ${active ? styles.runActionOptionActive : ''}`}
                data-active={active}
                role="menuitemradio"
                aria-checked={active}
                title={option.description || option.label}
                onClick={() => handlePickOption(option.value)}
              >
                <span className={styles.runActionOptionMeta}>
                  <span className={styles.runActionOptionLabel}>{option.label}</span>
                  {!!option.description && (
                    <span className={styles.runActionOptionDescription}>{option.description}</span>
                  )}
                </span>
                {active && (
                  <CheckIcon size={13} weight="bold" className={styles.runActionOptionCheck} />
                )}
              </button>
            )
          })}
          {(topRun.isConfigured || !!activeConfiguration) && (
            <button
              type="button"
              role="menuitem"
              className={styles.runActionReset}
              onClick={handleResetAuto}
            >
              {t('workbench.runResetToAuto')}
            </button>
          )}
        </div>
      </AnchoredPopover>
      <Dialog open={duplicateRunDialogOpen} onOpenChange={setDuplicateRunDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workbench.runDuplicateTitle')}</DialogTitle>
            <DialogDescription>
              {t('workbench.runDuplicateDescription', {
                command: activeConfiguration?.name ?? topRun.activeCommand,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDuplicateRunDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="outline" onClick={handleStartNewRun}>
              {t('workbench.runStartNew')}
            </Button>
            <Button onClick={handleRestartActiveCommand}>{t('workbench.runRestart')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function WorkbenchTopIconAction({
  tooltip,
  label,
  tooltipSide = 'top',
  disabled,
  onClick,
  children,
}: {
  tooltip: string
  label: string
  tooltipSide?: 'bottom' | 'left' | 'right' | 'top'
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}): ReactElement {
  return (
    <BubbleTooltip
      content={tooltip}
      ariaLabel={tooltip}
      delayDuration={80}
      side={tooltipSide}
      sideOffset={6}
    >
      <IconButton
        variant="ghost"
        size="icon-sm"
        className={styles.rightToolButton}
        label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </IconButton>
    </BubbleTooltip>
  )
}
