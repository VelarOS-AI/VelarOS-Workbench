/**
 * 新建项目对话框（最小模板起步：位置 + 名称 → 空目录并直接打开）。
 *
 * 校验与创建都在 main 侧项目枢纽完成，这里只收集输入并把失败原因翻译成提示文案。
 * 挂在应用顶层（起手页与工作台都能经菜单「新建项目…」唤起）。
 */
import { type ReactElement, useState } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Stack,
  Text,
} from '@velaros-ai/ui'

import type { WorkbenchProjectCreateFailureReason } from '../../../shared/projectHub'

interface NewProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CreateFailureMessageKeys: Record<WorkbenchProjectCreateFailureReason, string> = {
  'invalid-name': 'welcome.newProjectInvalidName',
  'location-missing': 'welcome.newProjectLocationMissing',
  'already-exists': 'welcome.newProjectAlreadyExists',
  'io-error': 'welcome.newProjectIoError',
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const [name, setName] = useState('')
  const [locationPath, setLocationPath] = useState('')
  const [failure, setFailure] = useState<Nullable<WorkbenchProjectCreateFailureReason>>(null)
  const [submitting, setSubmitting] = useState(false)

  const resetAndClose = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setName('')
      setLocationPath('')
      setFailure(null)
      setSubmitting(false)
    }
    onOpenChange(nextOpen)
  }

  const pickLocation = async (): Promise<void> => {
    const picked = await window.velarosWorkbenchProjectHub.pickNewProjectLocation()
    if (picked.ok) {
      setLocationPath(picked.path)
      setFailure(null)
    }
  }

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    const result = await window.velarosWorkbenchProjectHub.createProject(locationPath, name)
    setSubmitting(false)

    if (result.ok) {
      resetAndClose(false)
      return
    }

    setFailure(result.reason)
  }

  const canSubmit = !submitting && name.trim().length > 0 && locationPath.length > 0

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="workbench-new-project-dialog">
        <DialogHeader>
          <DialogTitle>{t('welcome.newProjectTitle')}</DialogTitle>
        </DialogHeader>
        <Stack gap="md">
          <Stack gap="xs">
            <Label htmlFor="workbench-new-project-name">{t('welcome.newProjectName')}</Label>
            <Input
              id="workbench-new-project-name"
              value={name}
              autoFocus
              placeholder="my-project"
              onChange={(event) => {
                setName(event.target.value)
                setFailure(null)
              }}
            />
          </Stack>
          <Stack gap="xs">
            <Label htmlFor="workbench-new-project-location">
              {t('welcome.newProjectLocation')}
            </Label>
            <div className="workbench-new-project-dialog__location">
              <Input
                id="workbench-new-project-location"
                value={locationPath}
                readOnly
                placeholder={t('welcome.newProjectLocationPlaceholder')}
              />
              <Button variant="outline" onClick={() => void pickLocation()}>
                {t('welcome.newProjectBrowse')}
              </Button>
            </div>
          </Stack>
          {failure !== null && (
            <Text tone="caption" className="workbench-new-project-dialog__error">
              {t(CreateFailureMessageKeys[failure])}
            </Text>
          )}
        </Stack>
        <DialogFooter>
          <Button variant="ghost" onClick={() => resetAndClose(false)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {t('welcome.newProjectCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
