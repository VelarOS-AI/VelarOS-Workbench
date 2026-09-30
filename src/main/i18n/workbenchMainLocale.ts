/**
 * main 进程的界面语言：跟着 renderer 走（界面语言由 renderer 保存，窗口打开、用户切换语言时报过来），还没报过时
 * 按系统语言猜，与 renderer 的初值同一条规则。应用菜单、main 侧给用户看的提示都按它出文字。
 */
import { app } from 'electron'

import type { AppLocale } from '@shared/contracts'

let reported: Nullable<AppLocale> = null
const listeners = new Set<() => void>()

export function isWorkbenchAppLocale(value: unknown): value is AppLocale {
  return value === 'en-US' || value === 'zh-CN'
}

export function getWorkbenchMainLocale(): AppLocale {
  if (reported) return reported
  const language = app.getPreferredSystemLanguages()[0] ?? app.getLocale()
  return /^zh\b/iu.test(language) ? 'zh-CN' : 'en-US'
}

export function setWorkbenchMainLocale(locale: AppLocale): void {
  if (locale === reported) return
  reported = locale
  for (const listener of listeners) listener()
}

export function onWorkbenchMainLocaleChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
