/**
 * 独立 Workbench 应用的轻量通知宿主（对位 desktop GlobalMessageContext 的 Workbench 消费面）。
 *
 * 复活的 surface 消费 `open/success/info/warning/error/clear` 六个动词，外加按 id 收起的
 * `dismiss`；这里用 sonner 直接实现同形 API（desktop 同为 sonner 内核）。相同内容在短窗口内只展示
 * 一次，并复用稳定 toast id，避免文件监听等重复事件把同一错误堆成多张卡片。带固定 `id` 的提示
 * （一直挂着、等状况解除再收起的那种）不走去重窗口：同一个 id 只有一张，后来的替换先前的。
 */
import type { ReactElement } from 'react'
import { toast, Toaster } from 'sonner'

import {
  makeWorkbenchMessageFingerprint,
  WorkbenchMessageDedupe,
} from './workbenchMessageDedupe'

import 'sonner/dist/styles.css'

export type WorkbenchMessageTone = 'error' | 'warning' | 'success' | 'info'

export interface WorkbenchMessageOptions {
  /** 固定的提示 id：同一个 id 只有一张，后来的替换先前的，可以用 `dismiss` 收起。 */
  id?: string
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
  /** 收起带固定 id 的那一张。 */
  dismiss: (id: string) => void
  clear: () => void
}

const messageDedupe = new WorkbenchMessageDedupe()

function show(options: WorkbenchMessageOptions): void {
  const tone: WorkbenchMessageTone = options.tone ?? 'info'
  const normalizedOptions = { ...options, tone }
  if (!options.id && messageDedupe.shouldSkip(normalizedOptions)) return

  const payload = {
    id: options.id ?? makeWorkbenchMessageFingerprint(normalizedOptions),
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
  dismiss: (id) => {
    toast.dismiss(id)
  },
  clear: () => {
    messageDedupe.clear()
    toast.dismiss()
  },
}

export function WorkbenchMessageHost(): ReactElement {
  return (
    <Toaster position="bottom-right" closeButton />
  )
}
