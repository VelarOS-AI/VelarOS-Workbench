import { Fragment, type ReactElement } from 'react'
import { CaretRightIcon, FolderIcon, FolderOpenIcon } from '@phosphor-icons/react'

import { Button } from '@velaros/ui/primitives/buttons/Button'
import { IconButton } from '@velaros/ui/primitives/buttons/IconButton'
import { FileTypeIcon } from '@velaros/ui/primitives/display/FileTypeIcon'
import { Text } from '@velaros/ui/primitives/display/Text'
import { useWorkbenchI18n } from '@velaros/workbench/i18n'
import type { WorkbenchPathBreadcrumbItem } from '@velaros/workbench/models/files/workbenchPathModel'

import styles from '../../styles/workbenchPageStyles'

interface EditorBreadcrumbBarProps {
  selectedFilePath: Nullable<string>
  breadcrumbItems: WorkbenchPathBreadcrumbItem[]
  onSelectOpenFile: (path: string) => void
  onOpenDirectory: (path: string) => void
  onRevealSelectedFile: () => void
}

export function EditorBreadcrumbBar({
  selectedFilePath,
  breadcrumbItems,
  onSelectOpenFile,
  onOpenDirectory,
  onRevealSelectedFile,
}: EditorBreadcrumbBarProps): Nullable<ReactElement> {
  const { t } = useWorkbenchI18n()

  if (!selectedFilePath) return null

  return (
    <nav className={styles.editorBreadcrumbBar} aria-label={t('workbench.editorBreadcrumbs')}>
      <div className={styles.editorBreadcrumbTrail}>
        {breadcrumbItems.map((item, index) => (
          <Fragment key={item.id}>
            {!!index && (
              <CaretRightIcon className={styles.editorBreadcrumbSeparator} size={11} />
            )}
            <Button
              variant="ghost"
              size="sm"
              className={styles.editorBreadcrumbItem}
              data-kind={item.kind}
              title={item.path}
              onClick={() => {
                if (item.kind === 'file') {
                  onSelectOpenFile(item.path)
                  return
                }

                onOpenDirectory(item.path)
              }}
            >
              {item.kind === 'file' ? (
                <FileTypeIcon fileName={item.label} size={13} />
              ) : item.kind === 'root' ? (
                <FolderOpenIcon size={13} weight="duotone" />
              ) : (
                <FolderIcon size={13} weight="duotone" />
              )}
              <Text truncate>{item.label}</Text>
            </Button>
          </Fragment>
        ))}
      </div>
      <IconButton
        variant="ghost"
        size="icon-sm"
        title={t('workbench.revealInFiles')}
        label={t('workbench.revealInFiles')}
        onClick={onRevealSelectedFile}
      >
        <FolderOpenIcon size={14} />
      </IconButton>
    </nav>
  )
}
