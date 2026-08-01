/**
 * 独立 Workbench 应用本地化实装（取代片0 的回显 key 占位 translator）。
 *
 * 语义对齐 desktop i18n 核心：点路径查目录 + `{param}` 插值 + miss 回落 key；
 * locale 状态由应用自持（localStorage 持久化，初始跟随系统语言），经
 * `WorkbenchI18nContextValue` 契约喂给单体源码内的 LocalizationProvider。
 */
import { useMemo, useState } from 'react'
import type {
  WorkbenchI18nContextValue,
  WorkbenchTranslateParams,
} from '@renderer/i18n'

import { isObject, isString } from '@velaros-ai/core'

import type { AppLocale } from '@shared/contracts'

import { workbenchAppEnUSMessages } from './messages/en-US'
import { workbenchAppZhCNMessages } from './messages/zh-CN'

const LOCALE_STORAGE_KEY = 'velaros-workbench-app:locale'

const messagesByLocale: Record<AppLocale, unknown> = {
  'en-US': workbenchAppEnUSMessages,
  'zh-CN': workbenchAppZhCNMessages,
}

function isAppLocale(value: unknown): value is AppLocale {
  return value === 'en-US' || value === 'zh-CN'
}

function readInitialLocale(): AppLocale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isAppLocale(stored)) return stored
  } catch {
    // localStorage 不可用时回落系统语言。
  }

  return /^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en-US'
}

function readMessage(locale: AppLocale, key: string): Nullable<string> {
  const value = key.split('.').reduce<unknown>((current, segment) => {
    if (!current || !isObject(current)) return null

    return (current as Record<string, unknown>)[segment]
  }, messagesByLocale[locale])

  return isString(value) ? value : null
}

function interpolate(template: string, params?: WorkbenchTranslateParams): string {
  if (!params) return template

  return template.replace(/\{(\w+)\}/g, (_match, token: string) => String(params[token] ?? ''))
}

export function translateWorkbenchAppMessage(
  locale: AppLocale,
  key: string,
  params?: WorkbenchTranslateParams
): string {
  const message = readMessage(locale, key) ?? readMessage('en-US', key) ?? key
  return interpolate(message, params)
}

export function useStandaloneWorkbenchLocalization(): WorkbenchI18nContextValue {
  const [locale, setLocale] = useState<AppLocale>(readInitialLocale)

  return useMemo<WorkbenchI18nContextValue>(
    () => ({
      locale,
      setLocale: (nextLocale) => {
        setLocale(nextLocale)
        try {
          window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale)
        } catch {
          // 持久化失败不阻断切换。
        }
        return Promise.resolve()
      },
      t: (key, params) => translateWorkbenchAppMessage(locale, key, params),
    }),
    [locale]
  )
}
