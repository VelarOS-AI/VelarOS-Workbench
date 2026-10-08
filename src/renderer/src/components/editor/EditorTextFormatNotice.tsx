import { type ReactElement, useState } from 'react'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import { resolveWorkbenchTextFormatNotice } from '@renderer/models/editor/workbenchEditorTextFormat'
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

import {
  formatWorkbenchTextEncoding,
  formatWorkbenchTextEol,
  type WorkbenchTextFormat,
} from '@shared/workbenchTextFormat'

import styles from '../../styles/workbenchPageStyles'

interface EditorTextFormatNoticeProps {
  tab: Pick<WorkbenchOpenEditorTab, 'file' | 'textConversion' | 'unencodableSaveError'>
  disabled: boolean
  onConvert?: (format: WorkbenchTextFormat) => void
}

/**
 * 当前文件不能按原样写回时的提示条：说明为什么只读（或为什么没存下去），给出用户明确选择的出路——
 * 转换为 UTF-8（先确认，确认后立即保存），或把混用的换行符统一成占多数的一种。
 */
export function EditorTextFormatNotice({
  tab,
  disabled,
  onConvert,
}: EditorTextFormatNoticeProps): Nullable<ReactElement> {
  const { t } = useWorkbenchI18n()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const notice = resolveWorkbenchTextFormatNotice(tab)
  if (!notice) return null

  const encoding = formatWorkbenchTextEncoding(notice.encoding)
  const eol = formatWorkbenchTextEol(notice.eol)
  const title =
    notice.kind === 'undecodable'
      ? t('workbench.textIssueUndecodableTitle')
      : notice.kind === 'irreversible'
        ? t('workbench.textIssueIrreversibleTitle', { encoding })
        : notice.kind === 'mixed-eol'
          ? t('workbench.textIssueMixedEolTitle')
          : t('workbench.textUnencodableSaveTitle', { encoding })
  const description =
    notice.kind === 'undecodable'
      ? t('workbench.textIssueUndecodableDescription')
      : notice.kind === 'irreversible'
        ? t('workbench.textIssueIrreversibleDescription', { encoding })
        : notice.kind === 'mixed-eol'
          ? t('workbench.textIssueMixedEolDescription', { eol })
          : (notice.message ?? '')
  const convertToUtf8 = (): void => {
    setConfirmOpen(false)
    onConvert?.({ encoding: 'utf-8', eol: notice.eol })
  }

  return (
    <>
      <div className={styles.editorExternalChangeBanner} data-status="text-format">
        <WarningCircleIcon size={16} />
        <div>
          <Text className={styles.editorExternalChangeTitle}>{title}</Text>
          <Text tone="secondary" truncate title={description}>
            {description}
          </Text>
        </div>
        {!!onConvert
          && (notice.kind === 'mixed-eol' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onConvert({ encoding: notice.encoding, eol: notice.eol })}
            >
              {t('workbench.textNormalizeEol', { eol })}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setConfirmOpen(true)}
            >
              {t('workbench.textConvertToUtf8')}
            </Button>
          ))}
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workbench.textConvertToUtf8DialogTitle')}</DialogTitle>
            <DialogDescription>
              {notice.kind === 'undecodable'
                ? t('workbench.textConvertToUtf8LossyDialogDescription')
                : t('workbench.textConvertToUtf8DialogDescription', { encoding })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              className={styles.editorDefaultActionButton}
              disabled={disabled}
              onClick={convertToUtf8}
            >
              {t('workbench.textConvertToUtf8Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
