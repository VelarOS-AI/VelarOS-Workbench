/**
 * 新建项目对话框（最小模板起步：位置 + 名称 → 空目录并直接打开）。
 *
 * 校验与创建都在 main 侧项目枢纽完成，这里只收集输入并把失败原因翻译成提示文案。
 * 挂在应用顶层（起手页与工作台都能经菜单「新建项目…」唤起）。
 */
import { type ReactElement, useState } from 'react'

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

const CreateFailureMessages: Record<WorkbenchProjectCreateFailureReason, string> = {
  'invalid-name': '项目名不可为空，且不能包含 \\ / : * ? " < > | 或以点开头。',
  'location-missing': '所选位置不存在或不是目录，请重新选择。',
  'already-exists': '该位置下已存在同名目录，换一个名称或位置。',
  'io-error': '目录创建失败，请检查磁盘权限后重试。',
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps): ReactElement {
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
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <Stack gap="md">
          <Stack gap="xs">
            <Label htmlFor="workbench-new-project-name">项目名称</Label>
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
            <Label htmlFor="workbench-new-project-location">位置</Label>
            <div className="workbench-new-project-dialog__location">
              <Input
                id="workbench-new-project-location"
                value={locationPath}
                readOnly
                placeholder="选择项目所在目录…"
              />
              <Button variant="outline" onClick={() => void pickLocation()}>
                浏览…
              </Button>
            </div>
          </Stack>
          {failure !== null && (
            <Text tone="caption" className="workbench-new-project-dialog__error">
              {CreateFailureMessages[failure]}
            </Text>
          )}
        </Stack>
        <DialogFooter>
          <Button variant="ghost" onClick={() => resetAndClose(false)}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            创建并打开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
