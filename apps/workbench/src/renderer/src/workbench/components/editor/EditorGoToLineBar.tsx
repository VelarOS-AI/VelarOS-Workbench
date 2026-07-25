import { HashIcon, XIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { Button } from '@velaros/ui/primitives/buttons/Button'
import { IconButton } from '@velaros/ui/primitives/buttons/IconButton'
import { Text } from '@velaros/ui/primitives/display/Text'
import { Input } from '@velaros/ui/primitives/forms/Input'
import { useWorkbenchI18n } from '@velaros/workbench/i18n'
import type { WorkbenchEditorGoToLineTarget } from '@velaros/workbench/models/editor/workbenchEditorModel'

import styles from '../../styles/workbenchPageStyles'

interface EditorGoToLineBarProps {
  goToLineInput: string
  editorLineCount: number
  goToLineTarget: Nullable<WorkbenchEditorGoToLineTarget>
  onGoToLineInputChange: (input: string) => void
  onSubmit: () => void
  onClose: () => void
}

export function EditorGoToLineBar({
  goToLineInput,
  editorLineCount,
  goToLineTarget,
  onGoToLineInputChange,
  onSubmit,
  onClose,
}: EditorGoToLineBarProps): ReactElement {
  const { t } = useWorkbenchI18n()

  return (
    <form
      className={styles.editorFindBar}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <HashIcon size={14} />
      <Input
        size="sm"
        variant="ghost"
        value={goToLineInput}
        autoFocus
        placeholder={t('workbench.goToLinePlaceholder')}
        onChange={(event) => onGoToLineInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <Text className={styles.editorFindMeta} tone="caption">
        {t('workbench.lineCount', { count: editorLineCount })}
      </Text>
      <Button type="submit" variant="ghost" size="sm" disabled={!goToLineTarget}>
        {t('workbench.goToLineSubmit')}
      </Button>
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={t('common.cancel')}
        title={t('common.cancel')}
        onClick={onClose}
      >
        <XIcon size={14} />
      </IconButton>
    </form>
  )
}
