import {
  type FormEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useMemo,
  useState,
} from 'react'
import {
  CheckIcon,
  GearSixIcon,
  PlayIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'

import { isEmpty,toNullable } from '@velaros-ai/core'
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

import type { SystemWorkspaceGitSummary } from '@shared/contracts'

import { type WorkbenchTopRunControl } from '../../hooks/useWorkbenchTopRunControl'
import styles from '../../styles/workbenchPageStyles'
import {
  WorkbenchGitCommitControl,
  type WorkbenchGitCommitControlVariant,
} from '../git/WorkbenchGitCommitControl'
import { WorkbenchGitSyncControl } from '../git/WorkbenchGitSyncControl'

export interface TopToolbarProps {
  gitWorkspaceRoot: string
  gitSummary: Nullable<SystemWorkspaceGitSummary>
  onGitRefresh: () => Promise<void>
  gitSshKeyPath?: string
  hasGitRepository: boolean
  hasUnsavedOpenTabs: boolean
  gitControlVariant?: WorkbenchGitCommitControlVariant
  onRepositoryChanged: () => void | Promise<void>
  onOpenGitCommitTool: () => void
  onOpenGitBottomTool: () => void
  onOpenQuickOpen: () => void
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
  gitControlVariant,
  onRepositoryChanged,
  onOpenGitCommitTool,
}: Pick<
  TopToolbarProps,
  | 'gitWorkspaceRoot'
  | 'gitSummary'
  | 'onGitRefresh'
  | 'gitSshKeyPath'
  | 'hasGitRepository'
  | 'hasUnsavedOpenTabs'
  | 'gitControlVariant'
  | 'onRepositoryChanged'
  | 'onOpenGitCommitTool'
>): Nullable<ReactElement> {
  const gitControlReady = !!gitSummary?.repository && !!gitSummary.status?.branch
  if (!gitControlReady) return null

  return (
    <div className={styles.topGitControl}>
      <WorkbenchGitCommitControl
        workspaceRoot={gitWorkspaceRoot}
        summary={gitSummary}
        onRefresh={onGitRefresh}
        gitSshKeyPath={gitSshKeyPath}
        hasUnsavedOpenTabs={hasUnsavedOpenTabs}
        variant={gitControlVariant ?? 'branch-menu-actions'}
        layout="pill"
        onRepositoryChanged={onRepositoryChanged}
        onOpenCommitTool={onOpenGitCommitTool}
      />
      <WorkbenchGitSyncControl
        workspaceRoot={gitWorkspaceRoot}
        summary={gitSummary}
        gitSshKeyPath={gitSshKeyPath}
        hasUnsavedOpenTabs={hasUnsavedOpenTabs}
        onRefresh={onGitRefresh}
        onOpenCommitTool={onOpenGitCommitTool}
      />
    </div>
  )
}

export function WorkbenchTopTrailing({
  onOpenSettings,
  topRun,
  isRunningCommand,
  hasActiveRunCommand,
}: Pick<
  TopToolbarProps,
  | 'onOpenSettings'
  | 'topRun'
  | 'isRunningCommand'
  | 'hasActiveRunCommand'
>): ReactElement {
  const { t } = useWorkbenchI18n()
  const runCommandLabel = t('workbench.runCommand')
  const settingsLabel = t('workbench.settingsTitle')

  return (
    <>
      <WorkbenchRunAction
        topRun={topRun}
        label={runCommandLabel}
        placeholder={t('workbench.runConfigurationPlaceholder')}
        className={styles.topRunButton}
        tooltipSide="top"
        isRunningCommand={isRunningCommand}
        hasActiveRunCommand={hasActiveRunCommand}
      />
      <WorkbenchTopIconAction
        tooltip={settingsLabel}
        label={settingsLabel}
        tooltipSide="top"
        onClick={onOpenSettings}
      >
        <GearSixIcon size={17} />
      </WorkbenchTopIconAction>
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
    () => toNullable(topRun.options.find((option) => option.value === topRun.activeCommand)),
    [topRun.activeCommand, topRun.options]
  )
  // 一次性 runner（程序化/agent）占用只影响转圈图标，不禁用侧边栏按钮；
  // 用户命令走可并行的 PTY 运行卡，相同命令由确认框裁决重新运行还是新开。
  const oneShotBusy = isRunningCommand || hasActiveRunCommand
  const activeLabel = topRun.isConfigured
    ? topRun.configuredCommand
    : (activeOption?.label ?? topRun.activeCommand)
  const activeDescription = topRun.isConfigured
    ? t('workbench.runConfiguredCommand')
    : activeOption?.description?.trim()
  const configureHint = t('workbench.runRightClickToConfigure')
  const tooltipTitle = activeLabel || placeholder
  const actionLabel = [
    label,
    tooltipTitle,
    activeDescription,
    configureHint,
  ]
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
    topRun.configureCommand(draftCommand)
    setMenuOpen(false)
  }

  function handlePickOption(command: string): void {
    topRun.configureCommand(command)
    setMenuOpen(false)
  }

  function handleResetAuto(): void {
    topRun.configureCommand('')
    setDraftCommand('')
    setMenuOpen(false)
  }

  return (
    <>
      <AnchoredPopover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        className={styles.runActionPopover}
        side="left"
        align="start"
        sideOffset={8}
        widthStrategy="content"
        anchor={({ getAnchorProps }) => (
          <BubbleTooltip
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
        <div className={styles.runActionPanel} role="menu" aria-label={placeholder}>
        <form className={styles.runActionConfig} onSubmit={handleConfigSubmit}>
          <span className={styles.runActionConfigLabel}>{t('workbench.runConfigureCommand')}</span>
          <div className={styles.runActionConfigRow}>
            <Input
              autoFocus
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
          const active = option.value === topRun.activeCommand
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
        {topRun.isConfigured && (
          <button type="button" className={styles.runActionReset} onClick={handleResetAuto}>
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
              {t('workbench.runDuplicateDescription', { command: topRun.activeCommand })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDuplicateRunDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="outline" onClick={handleStartNewRun}>
              {t('workbench.runStartNew')}
            </Button>
            <Button onClick={handleRestartActiveCommand}>
              {t('workbench.runRestart')}
            </Button>
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
        label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </IconButton>
    </BubbleTooltip>
  )
}

/** 旧的独立标题行；工作台现在在编辑器面板中组合左侧、标签和右侧区域。 */
export function TopToolbar(props: TopToolbarProps): ReactElement {
  return (
    <header className={styles.workbenchTopToolbar}>
      <div className={styles.topToolbarLeft}>
        <WorkbenchTopLeading {...props} />
      </div>
      <div className={styles.topToolbarRight}>
        <WorkbenchTopTrailing {...props} />
      </div>
    </header>
  )
}
