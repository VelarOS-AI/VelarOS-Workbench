import { type ReactElement, useState } from 'react'
import { useWorkbenchProductAnalytics } from '@renderer/hooks/useWorkbenchProductAnalytics'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'

import styles from '../../styles/workbenchPageStyles'

export function WorkbenchProductAnalyticsNoticeDialog(): ReactElement | null {
  const { t } = useWorkbenchI18n()
  const analytics = useWorkbenchProductAnalytics()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Nullable<string>>(null)
  const state = analytics.state
  const open =
    state?.ok && state.data.enabled && state.data.noticeRequired && !state.data.noticeResolved
  if (!open) return null

  const resolve = (decision: 'allowed' | 'declined'): void => {
    if (pending) return
    setPending(true)
    setFailure(null)
    void analytics.resolveNotice(decision).then(
      () => setPending(false),
      (error: unknown) => {
        setPending(false)
        setFailure(error instanceof Error ? error.message : String(error))
      }
    )
  }

  return (
    <Dialog open>
      <DialogContent
        className="velar-confirm-dialog"
        showClose={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('workbench.settingsProductAnalytics')}</DialogTitle>
          <DialogDescription className={styles.productAnalyticsNoticeDescription}>
            {t('workbench.productAnalyticsNoticeDescription')}
          </DialogDescription>
        </DialogHeader>
        {failure && <p role="alert">{failure}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => resolve('declined')}
          >
            {t('workbench.productAnalyticsNoticeDecline')}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => resolve('allowed')}>
            {t('workbench.productAnalyticsNoticeAllow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
