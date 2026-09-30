import { type ReactElement } from 'react'
import { SquareSplitHorizontalIcon } from '@phosphor-icons/react'
import { useWorkbenchDiffLayout } from '@renderer/hooks/useWorkbenchPreferences'
import { useWorkbenchI18n } from '@renderer/i18n'
import { saveWorkbenchDiffLayout } from '@renderer/models/settings/workbenchPreferences'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import styles from '../../styles/workbenchPageStyles'

/**
 * 差异查看器工具栏上的开关：改动前后上下合在一栏，还是左右并排。选的排法存进偏好（`diffLayout`），
 * Git 改动、本地历史、AI 改动的查看器用的是同一个，下次打开还是它。
 */
export function WorkbenchDiffLayoutToggle(): ReactElement {
  const { t } = useWorkbenchI18n()
  const split = useWorkbenchDiffLayout() === 'split'
  const label = t(split ? 'workbench.gitDiffShowUnified' : 'workbench.gitDiffShowSideBySide')
  return (
    <IconButton
      variant="ghost"
      size="icon-sm"
      className={styles.diffLayoutToggle}
      label={label}
      title={label}
      aria-pressed={split}
      onClick={() => saveWorkbenchDiffLayout(split ? 'unified' : 'split')}
    >
      <SquareSplitHorizontalIcon size={14} />
    </IconButton>
  )
}
