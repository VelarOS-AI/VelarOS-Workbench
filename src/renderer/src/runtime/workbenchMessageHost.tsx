/**
 * 独立 Workbench 应用的轻量通知宿主（对位 desktop GlobalMessageContext 的 Workbench 消费面）。
 *
 * 复活的 surface 只消费 `open/success/info/warning/error/clear` 六个动词；这里用 sonner
 * 直接实现同形 API（desktop 同为 sonner 内核）。相同内容在短窗口内只展示一次，并复用
 * 稳定 toast id，避免文件监听等重复事件把同一错误堆成多张卡片。
 */
import type { ReactElement } from 'react'
import { toast, Toaster } from 'sonner'

import { WorkbenchUpdateProgress } from '../components/updates/WorkbenchUpdateProgress'

import {
  makeWorkbenchMessageFingerprint,
  WorkbenchMessageDedupe,
} from './workbenchMessageDedupe'

import 'sonner/dist/styles.css'

export type WorkbenchMessageTone = 'error' | 'warning' | 'success' | 'info'

export interface WorkbenchMessageOptions {
  title: string
  description?: string
  tone?: WorkbenchMessageTone
  duration?: number
  showClose?: boolean
  onClose?: () => void
}

export interface WorkbenchMessageApi {
  open: (options: WorkbenchMessageOptions) => void
  success: (options: Omit<WorkbenchMessageOptions, 'tone'>) => void
  info: (options: Omit<WorkbenchMessageOptions, 'tone'>) => void
  warning: (options: Omit<WorkbenchMessageOptions, 'tone'>) => void
  error: (options: Omit<WorkbenchMessageOptions, 'tone'>) => void
  clear: () => void
}

const messageDedupe = new WorkbenchMessageDedupe()

function show(options: WorkbenchMessageOptions): void {
  const tone: WorkbenchMessageTone = options.tone ?? 'info'
  const normalizedOptions = { ...options, tone }
  if (messageDedupe.shouldSkip(normalizedOptions)) return

  const payload = {
    id: makeWorkbenchMessageFingerprint(normalizedOptions),
    description: options.description,
    duration: options.duration,
    closeButton: options.showClose ?? true,
    onDismiss: options.onClose,
  }

  switch (tone) {
    case 'error':
      toast.error(options.title, payload)
      break
    case 'warning':
      toast.warning(options.title, payload)
      break
    case 'success':
      toast.success(options.title, payload)
      break
    default:
      toast.info(options.title, payload)
  }
}

export const workbenchMessage: WorkbenchMessageApi = {
  open: show,
  success: (options) => show({ ...options, tone: 'success' }),
  info: (options) => show({ ...options, tone: 'info' }),
  warning: (options) => show({ ...options, tone: 'warning' }),
  error: (options) => show({ ...options, tone: 'error' }),
  clear: () => {
    messageDedupe.clear()
    toast.dismiss()
  },
}

export function WorkbenchMessageHost(): ReactElement {
  return (
    <>
      <WorkbenchUpdateProgress />
      <Toaster position="bottom-right" closeButton />
    </>
  )
}
