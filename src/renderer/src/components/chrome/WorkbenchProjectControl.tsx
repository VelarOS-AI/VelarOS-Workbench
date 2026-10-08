import {
  type CSSProperties,
  type FormEvent,
  type ReactElement,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckIcon,
  FolderOpenIcon,
  GitBranchIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

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
import { getTopBarControlPanelClassName } from '@velaros-ai/ui/product/layout/TopBarControlFrame'

import type {
  WorkbenchProjectCloneFailureReason,
  WorkbenchProjectCloneResult,
  WorkbenchProjectHubState,
} from '@shared/projectHub'

import styles from '../../styles/workbenchPageStyles'

interface WorkbenchProjectControlProps {
  state: WorkbenchProjectHubState
  onSwitchProject: (path: string) => Promise<boolean>
  onOpenProjectInNewWindow: (path: string) => Promise<boolean>
  onAddLocalProject: () => Promise<boolean>
  onCloneProjectInNewWindow: (remoteUrl: string) => Promise<WorkbenchProjectCloneResult>
}

type PendingProjectAction = 'add-local' | 'clone' | `switch:${string}` | `new:${string}`

interface ProjectControlThemeTokens {
  color: string
  colorRgb: string
  scope: Nullable<string>
}

function resolveProjectThemeTokens(
  anchor: Nullable<HTMLElement>
): Nullable<ProjectControlThemeTokens> {
  if (!anchor) return null
  const probe = anchor.ownerDocument.createElement('span')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.color = 'var(--workbench-theme-color)'
  anchor.append(probe)
  const view = anchor.ownerDocument.defaultView
  const color = view?.getComputedStyle(probe).color.trim() ?? ''
  const colorRgb = view
    ?.getComputedStyle(anchor)
    .getPropertyValue('--workbench-theme-color-rgb')
    .trim()
  probe.remove()
  if (!color || !colorRgb) return null

  return {
    color,
    colorRgb,
    scope:
      anchor
        .closest<HTMLElement>('[data-velar-theme-scope]')
        ?.getAttribute('data-velar-theme-scope') ?? null,
  }
}

export function WorkbenchProjectControl({
  state,
  onSwitchProject,
  onOpenProjectInNewWindow,
  onAddLocalProject,
  onCloneProjectInNewWindow,
}: WorkbenchProjectControlProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const [open, setOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<Nullable<PendingProjectAction>>(null)
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  const [cloneRemoteUrl, setCloneRemoteUrl] = useState('')
  const [cloneError, setCloneError] = useState<Nullable<string>>(null)
  const [themeTokens, setThemeTokens] = useState<Nullable<ProjectControlThemeTokens>>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const currentProject = state.currentProject
  const initials = useMemo(
    () => (currentProject?.name.trim().slice(0, 2) || 'WB').toLocaleUpperCase(),
    [currentProject?.name]
  )

  async function runAction(
    action: PendingProjectAction,
    task: () => Promise<boolean>
  ): Promise<void> {
    if (pendingAction) return
    try {
      setPendingAction(action)
      if (await task()) setOpen(false)
    } finally {
      setPendingAction(null)
    }
  }

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen)
    if (nextOpen) setThemeTokens(resolveProjectThemeTokens(anchorRef.current))
  }

  function openCloneDialog(): void {
    setThemeTokens(resolveProjectThemeTokens(anchorRef.current))
    setOpen(false)
    setCloneRemoteUrl('')
    setCloneError(null)
    setCloneDialogOpen(true)
  }

  function handleCloneDialogOpenChange(nextOpen: boolean): void {
    if (!nextOpen && pendingAction === 'clone') return
    setCloneDialogOpen(nextOpen)
    if (!nextOpen) {
      setCloneRemoteUrl('')
      setCloneError(null)
    }
  }

  function cloneFailureMessage(reason: WorkbenchProjectCloneFailureReason): string {
    if (reason === 'invalid-remote') return t('workbench.projectCloneInvalidRemote')
    if (reason === 'already-exists') return t('workbench.projectCloneAlreadyExists')
    return t('workbench.projectCloneFailed')
  }

  async function cloneProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const remoteUrl = cloneRemoteUrl.trim()
    if (!remoteUrl || pendingAction) return

    try {
      setPendingAction('clone')
      setCloneError(null)
      const result = await onCloneProjectInNewWindow(remoteUrl)
      if (result.ok) {
        setCloneDialogOpen(false)
        setCloneRemoteUrl('')
        return
      }
      if (result.reason !== 'canceled') setCloneError(cloneFailureMessage(result.reason))
    } finally {
      setPendingAction(null)
    }
  }

  const themeStyle = {
    '--project-control-theme-color': themeTokens?.color ?? 'var(--workbench-theme-color)',
    '--project-control-theme-color-rgb':
      themeTokens?.colorRgb ?? 'var(--workbench-theme-color-rgb)',
  } as CSSProperties

  return (
    <>
      <AnchoredPopover
      open={open}
      onOpenChange={handleOpenChange}
      anchorClassName={styles.projectControlAnchor}
      className={getTopBarControlPanelClassName(styles.projectControlMenu)}
      data-topbar-panel="picker"
      side="bottom"
      align="start"
      sideOffset={6}
      widthStrategy="content"
      style={themeStyle}
      anchor={({ getAnchorProps }) => (
        <Button
          {...getAnchorProps<HTMLButtonElement>({ ref: anchorRef })}
          variant="ghost"
          size="sm"
          className={styles.projectControlButton}
          title={currentProject?.path}
        >
          <span className={styles.projectControlBadge}>{initials}</span>
          <span className={styles.projectControlName}>{currentProject?.name}</span>
          <CaretDownIcon size={11} />
        </Button>
      )}
    >
      <div className={styles.projectControlMenuHeader}>
        {t('workbench.projectRecentProjects')}
      </div>
      <div className={styles.projectControlRecentList}>
        {state.recentProjects.length === 0 ? (
          <div className={styles.projectControlEmpty}>
            {t('workbench.projectNoRecentProjects')}
          </div>
        ) : (
          state.recentProjects.map((project) => {
            const current = project.path === currentProject?.path
            const switching = pendingAction === `switch:${project.path}`
            const opening = pendingAction === `new:${project.path}`
            return (
              <div key={project.path} className={styles.projectControlRecentRow}>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.projectControlRecentMain}
                  disabled={project.missing || current || !!pendingAction}
                  title={project.path}
                  onClick={() =>
                    void runAction(`switch:${project.path}`, () => onSwitchProject(project.path))
                  }
                >
                  <span className={styles.projectControlRecentIcon}>
                    {switching ? (
                      <SpinnerGapIcon size={14} className={styles.spinIcon} />
                    ) : current ? (
                      <CheckIcon size={14} weight="bold" />
                    ) : (
                      <FolderOpenIcon size={14} weight="duotone" />
                    )}
                  </span>
                  <span className={styles.projectControlRecentCopy}>
                    <span>{project.name}</span>
                    <small>{project.path}</small>
                  </span>
                </Button>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  className={styles.projectControlNewWindowButton}
                  disabled={project.missing || current || !!pendingAction}
                  title={t('workbench.projectOpenInNewWindow')}
                  label={t('workbench.projectOpenInNewWindow')}
                  onClick={() =>
                    void runAction(`new:${project.path}`, () =>
                      onOpenProjectInNewWindow(project.path)
                    )
                  }
                >
                  {opening ? (
                    <SpinnerGapIcon size={14} className={styles.spinIcon} />
                  ) : (
                    <ArrowSquareOutIcon size={14} />
                  )}
                </IconButton>
              </div>
            )
          })
        )}
      </div>
      <div className={styles.projectControlActions}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!!pendingAction}
          onClick={() => void runAction('add-local', onAddLocalProject)}
        >
          {pendingAction === 'add-local' ? (
            <SpinnerGapIcon size={14} className={styles.spinIcon} />
          ) : (
            <FolderOpenIcon size={14} />
          )}
          {t('workbench.projectAddLocal')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!!pendingAction}
          onClick={openCloneDialog}
        >
          <GitBranchIcon size={14} />
          {t('workbench.projectCloneRemote')}
        </Button>
      </div>
      </AnchoredPopover>

      <Dialog open={cloneDialogOpen} onOpenChange={handleCloneDialogOpenChange}>
        <DialogContent
          className={styles.projectCloneDialog}
          data-velar-theme-scope={themeTokens?.scope ?? undefined}
          style={themeStyle}
        >
          <DialogHeader>
            <DialogTitle>{t('workbench.projectCloneTitle')}</DialogTitle>
            <DialogDescription>{t('workbench.projectCloneDescription')}</DialogDescription>
          </DialogHeader>
          <form className={styles.projectCloneForm} onSubmit={cloneProject}>
            <Input
              autoFocus
              size="sm"
              value={cloneRemoteUrl}
              disabled={pendingAction === 'clone'}
              placeholder={t('workbench.projectCloneUrlPlaceholder')}
              onChange={(event) => {
                setCloneRemoteUrl(event.target.value)
                setCloneError(null)
              }}
            />
            {cloneError && <p className={styles.projectCloneError}>{cloneError}</p>}
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={pendingAction === 'clone'}
                onClick={() => handleCloneDialogOpenChange(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                className={styles.projectCloneSubmit}
                size="sm"
                type="submit"
                disabled={!cloneRemoteUrl.trim() || pendingAction === 'clone'}
              >
                {pendingAction === 'clone' ? (
                  <SpinnerGapIcon size={14} className={styles.spinIcon} />
                ) : (
                  <GitBranchIcon size={14} />
                )}
                {t('workbench.projectCloneSubmit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
