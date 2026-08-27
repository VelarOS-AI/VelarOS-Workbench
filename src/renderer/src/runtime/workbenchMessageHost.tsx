/**
 * 独立 Workbench 应用的轻量通知宿主（对位 desktop GlobalMessageContext 的 Workbench 消费面）。
 *
 * 复活的 surface 只消费 `open/success/info/warning/error/clear` 六个动词；这里用 sonner
 * 直接实现同形 API（desktop 同为 sonner 内核），不搬 desktop 的去重/布局层——独立应用
 * 的通知量级用不上。`<WorkbenchMessageHost/>` 挂在应用壳顶层渲染 Toaster。
 */
import type { ReactElement } from 'react'
import { toast, Toaster } from 'sonner'

import { WorkbenchUpdateProgress } from '../components/updates/WorkbenchUpdateProgress'

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

function show(options: WorkbenchMessageOptions): void {
  const tone: WorkbenchMessageTone = options.tone ?? 'info'
  const payload = {
    description: options.description,
    duration: options.duration,
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
  clear: () => toast.dismiss(),
}

export function WorkbenchMessageHost(): ReactElement {
  return (
    <>
      <WorkbenchUpdateProgress />
      <Toaster position="bottom-right" closeButton />
    </>
  )
}
