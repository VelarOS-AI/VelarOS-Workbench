import { CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { IconButton } from '@velaros/ui/primitives/buttons/IconButton'
import { Text } from '@velaros/ui/primitives/display/Text'
import { Input } from '@velaros/ui/primitives/forms/Input'
import { useWorkbenchI18n } from '@velaros/workbench/i18n'
import type { WorkbenchEditorFindMatch } from '@velaros/workbench/models/editor/workbenchEditorModel'

import styles from '../../styles/workbenchPageStyles'

interface EditorFindBarProps {
  findQuery: string
  findMatches: WorkbenchEditorFindMatch[]
  activeFindIndex: number
  hasActiveFindSelection: boolean
  onFindQueryChange: (query: string) => void
  onClose: () => void
  onSelectMatch: (index: number) => void
}

export function EditorFindBar({
  findQuery,
  findMatches,
  activeFindIndex,
  hasActiveFindSelection,
  onFindQueryChange,
  onClose,
  onSelectMatch,
}: EditorFindBarProps): ReactElement {
  const { t } = useWorkbenchI18n()

  return (
    <form
      className={styles.editorFindBar}
      onSubmit={(event) => {
        event.preventDefault()
        onSelectMatch(activeFindIndex)
      }}
    >
      <MagnifyingGlassIcon size={14} />
      <Input
        size="sm"
        variant="ghost"
        value={findQuery}
        autoFocus
        placeholder={t('workbench.findInFile')}
        onChange={(event) => onFindQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <Text className={styles.editorFindMeta} tone="caption">
        {findQuery
          ? findMatches.length
            ? t('workbench.findMatchCount', {
                current: Math.min(activeFindIndex + 1, findMatches.length),
                total: findMatches.length,
              })
            : t('workbench.findNoMatches')
          : ''}
      </Text>
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={t('workbench.findPrevious')}
        title={t('workbench.findPrevious')}
        disabled={!findMatches.length}
        onClick={() => onSelectMatch(hasActiveFindSelection ? activeFindIndex - 1 : 0)}
      >
        <CaretUpIcon size={14} />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={t('workbench.findNext')}
        title={t('workbench.findNext')}
        disabled={!findMatches.length}
        onClick={() => onSelectMatch(hasActiveFindSelection ? activeFindIndex + 1 : 0)}
      >
        <CaretDownIcon size={14} />
      </IconButton>
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
