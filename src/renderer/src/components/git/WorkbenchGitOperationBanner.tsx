import { type ReactElement } from 'react'
import { GitMergeIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import {
  describeWorkbenchGitOperationBanner,
  getWorkbenchGitOperationName,
} from '@renderer/models/git/workbenchGitOperationModel'

import { type WorkspaceGitOperationAction, type WorkspaceGitOperationState } from '@shared/contracts/workspaceGit'

import styles from '../../styles/workbenchPageStyles'

interface WorkbenchGitOperationBannerProps {
  operation: WorkspaceGitOperationState
  /** 项目里还没解决的冲突文件数。 */
  conflictCount: number
  /** 正在跑的那一步（不管是哪里点的）；跑着的时候三个按钮都按不了。 */
  pending: Nullable<WorkspaceGitOperationAction>
  /** 编辑器里有没保存的内容：这几步都会改写磁盘上的文件，先保存。 */
  hasUnsavedOpenTabs: boolean
  onAction: (action: 'continue' | 'skip' | 'abort') => void
}

/**
 * 合并、变基、拣选、撤销进行到一半时的提示：是什么操作、停在哪、接下来该做什么，和继续、跳过、放弃。
 * 提交面板和 Git 工具窗上方各放一张。在终端里起了头的操作同样显示（看的是仓库里的标记）。
 *
 * 按钮是这张卡片自己的小号按钮（24px）：共享 Button 最小一档是 32px，放在两行字的提示里比字还抢眼。
 */
export function WorkbenchGitOperationBanner({
  operation,
  conflictCount,
  pending,
  hasUnsavedOpenTabs,
  onAction,
}: WorkbenchGitOperationBannerProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const banner = describeWorkbenchGitOperationBanner(operation, conflictCount, t)
  const name = getWorkbenchGitOperationName(operation.kind, t)
  const blocked = !!pending || hasUnsavedOpenTabs
  const unsavedHint = hasUnsavedOpenTabs ? t('workbench.gitUnsavedBlockedDescription') : null

  return (
    <div
      className={styles.gitOperationBanner}
      role="status"
      data-conflicts={conflictCount > 0 ? 'true' : undefined}
    >
      <div className={styles.gitOperationBannerCard}>
        <GitMergeIcon size={14} weight="bold" className={styles.gitOperationBannerIcon} />
        <span className={styles.gitOperationBannerTitle}>
          <strong>{banner.title}</strong>
          {!!banner.detail && <small title={banner.detail}>{banner.detail}</small>}
        </span>
        <span className={styles.gitOperationBannerHint}>{banner.hint}</span>
        <div className={styles.gitOperationBannerActions}>
          <button
            type="button"
            className={styles.gitOperationBannerButton}
            data-variant="primary"
            disabled={blocked || !banner.canContinue}
            title={
              unsavedHint ??
              (banner.canContinue
                ? t('workbench.gitOperationContinueHint', { operation: name })
                : t('workbench.gitOperationContinueBlockedHint'))
            }
            onClick={() => onAction('continue')}
          >
            {pending === 'continue' && <SpinnerGapIcon size={12} className={styles.spinIcon} />}
            {t('workbench.gitOperationContinue')}
          </button>
          {banner.canSkip && (
            <button
              type="button"
              className={styles.gitOperationBannerButton}
              disabled={blocked}
              title={unsavedHint ?? t('workbench.gitOperationSkipHint')}
              onClick={() => onAction('skip')}
            >
              {pending === 'skip' && <SpinnerGapIcon size={12} className={styles.spinIcon} />}
              {t('workbench.gitOperationSkip')}
            </button>
          )}
          <button
            type="button"
            className={styles.gitOperationBannerButton}
            data-variant="danger"
            disabled={blocked}
            title={unsavedHint ?? t('workbench.gitOperationAbortHint', { operation: name })}
            onClick={() => onAction('abort')}
          >
            {pending === 'abort' && <SpinnerGapIcon size={12} className={styles.spinIcon} />}
            {t('workbench.gitOperationAbort')}
          </button>
        </div>
      </div>
    </div>
  )
}
