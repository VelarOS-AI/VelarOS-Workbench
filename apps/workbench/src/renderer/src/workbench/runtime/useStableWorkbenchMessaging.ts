/**
 * 独立 Workbench 应用的通知 + 本地化组合适配器
 * （对位 desktop `@/runtime/workbench/useStableWorkbenchMessaging`，返回面形状逐字一致）。
 */
import { useWorkbenchI18n } from '@velaros/workbench/i18n'

import { useLatest } from '../support/genericHooks'

import { workbenchMessage } from './workbenchMessageHost'

export function useStableWorkbenchMessageTranslate() {
  const i18n = useWorkbenchI18n()
  const messageLatest = useLatest(workbenchMessage)
  const tLatest = useLatest(i18n.t)
  return { ...i18n, messageLatest, tLatest }
}
