import { type FormEvent, type ReactElement, useEffect, useId, useState } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'
import { shouldWorkbenchGitStashIncludeUntrackedByDefault } from '@renderer/models/git/workbenchGitStashModel'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'

import type { WorkspaceGitStashOptions } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'

interface WorkbenchGitStashDialogProps {
  open: boolean
  /** 有改动的已跟踪文件数、未跟踪文件数：没有未跟踪的就不问要不要带上它们。 */
  trackedCount: number
  untrackedCount: number
  /** 正在贮藏：按钮先禁用，对话框不让关。 */
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (options: WorkspaceGitStashOptions) => void
}

/** 「贮藏改动」对话框：可以写一句说明，可以连未跟踪的文件一起收起来。 */
export function WorkbenchGitStashDialog({
  open,
  trackedCount,
  untrackedCount,
  pending,
  onOpenChange,
  onSubmit,
}: WorkbenchGitStashDialogProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const untrackedOptionId = useId()
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const nothingWithoutUntracked = trackedCount === 0

  // 每次打开都从头填：说明清空，未跟踪文件带不带按打开那一刻的改动定（开着的时候文件数变了，不改用户
  // 已经勾的，所以依赖里只有 open）。
  const countsLatest = useLatest({ tracked: trackedCount, untracked: untrackedCount })
  useEffect(() => {
    if (!open) return
    setMessage('')
    setIncludeUntracked(shouldWorkbenchGitStashIncludeUntrackedByDefault(countsLatest.current))
  }, [countsLatest, open])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (pending) return
    onSubmit({ message: message.trim() || undefined, includeUntracked })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!pending || next) && onOpenChange(next)}>
      <DialogContent>
        <form className={styles.gitStashDialogForm} onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('workbench.gitStashDialogTitle')}</DialogTitle>
            <DialogDescription>{t('workbench.gitStashDialogDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            size="sm"
            value={message}
            maxLength={200}
            placeholder={t('workbench.gitStashMessagePlaceholder')}
            aria-label={t('workbench.gitStashMessagePlaceholder')}
            disabled={pending}
            onChange={(event) => setMessage(event.target.value)}
          />
          {untrackedCount > 0 && (
            <div className={styles.gitStashOption}>
              <Checkbox
                id={untrackedOptionId}
                size="sm"
                checked={includeUntracked}
                disabled={pending}
                onCheckedChange={setIncludeUntracked}
              />
              <label htmlFor={untrackedOptionId}>
                <span>{t('workbench.gitStashIncludeUntracked', { count: untrackedCount })}</span>
                <small>{t('workbench.gitStashIncludeUntrackedHint')}</small>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending || (nothingWithoutUntracked && !includeUntracked)}>
              {t('workbench.gitStashConfirmAction')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
