import { type ReactElement } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchEditorAutosaveFailures } from '@renderer/models/editor/workbenchEditorAutosave'
import {
  type WorkbenchEditorCloseChoice,
  type WorkbenchEditorCloseRequest,
  workbenchEditorTabFileName,
} from '@renderer/models/editor/workbenchEditorTabClose'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'

import styles from '../../styles/workbenchPageStyles'

interface EditorUnsavedChangesDialogProps {
  request: Nullable<WorkbenchEditorCloseRequest>
  openTabs: readonly WorkbenchOpenEditorTab[]
  autosaveFailures?: WorkbenchEditorAutosaveFailures
  /** 正在按「保存」写盘：按钮先不给点。 */
  saving: boolean
  onResolve: (choice: WorkbenchEditorCloseChoice) => void
}

/**
 * 关闭有未保存改动的标签（或窗口）前的确认：保存 / 不保存 / 取消。批量关闭只问一次，
 * 列出每个有改动的文件；存不下的（磁盘上被删了、被外部改了、写盘或自动保存失败）写明原因。
 * 关窗与退出前只列替用户存过一遍之后仍没存下的文件。
 */
export function EditorUnsavedChangesDialog({
  request,
  openTabs,
  autosaveFailures,
  saving,
  onResolve,
}: EditorUnsavedChangesDialogProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const dirtyPaths = request?.dirtyPaths ?? []
  const singlePath = request?.kind === 'tabs' && dirtyPaths.length === 1 ? dirtyPaths[0] : null

  function describeUnsavedReason(path: string): Nullable<string> {
    const change = openTabs.find((tab) => tab.path === path)?.externalChange
    if (change?.status === 'deleted') return t('workbench.externalFileDeletedTitle')
    if (change?.status === 'modified') return t('workbench.externalFileChangedTitle')
    if (change) return t('workbench.externalFileUnavailableTitle')

    const saveFailure = request?.reasons?.[path]
    if (saveFailure) return t('workbench.unsavedCloseSaveFailed', { reason: saveFailure })

    const failure = autosaveFailures?.get(path)
    return failure ? t('workbench.autosaveFailedTooltip', { reason: failure.message }) : null
  }

  const title =
    request?.kind === 'window'
      ? request.windowReason === 'quit'
        ? t('workbench.unsavedQuitTitle')
        : t('workbench.unsavedWindowCloseTitle')
      : singlePath
        ? t('workbench.unsavedCloseTitle', { name: workbenchEditorTabFileName(singlePath) })
        : t('workbench.unsavedCloseTitleMany', { count: dirtyPaths.length })
  const description =
    request?.kind === 'window'
      ? t('workbench.unsavedWindowCloseDescription')
      : t('workbench.unsavedCloseDescription')

  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open && !saving) onResolve('cancel')
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ul className={styles.editorUnsavedFileList}>
          {dirtyPaths.map((path) => {
            const reason = describeUnsavedReason(path)
            return (
              <li key={path} className={styles.editorUnsavedFileItem}>
                <Text className={styles.editorUnsavedFilePath} truncate title={path}>
                  {path}
                </Text>
                {!!reason && <Text tone="caption">{reason}</Text>}
              </li>
            )
          })}
        </ul>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => onResolve('cancel')}>
            {t('common.cancel')}
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => onResolve('discard')}>
            {t('workbench.unsavedCloseDiscard')}
          </Button>
          <Button
            className={styles.editorDefaultActionButton}
            disabled={saving}
            onClick={() => onResolve('save')}
          >
            {saving
              ? t('workbench.savingFile')
              : singlePath
                ? t('workbench.unsavedCloseSave')
                : t('workbench.unsavedCloseSaveAll')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
