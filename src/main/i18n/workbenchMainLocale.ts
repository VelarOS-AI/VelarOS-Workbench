/**
 * main 进程的界面语言：跟着 renderer 走（界面语言由 renderer 保存，窗口打开、用户切换语言时报过来），还没报过时
 * 按系统语言猜，与 renderer 的初值同一条规则。应用菜单、main 侧给用户看的提示都按它出文字。
 *
 * 系统语言由 main 入口在应用就绪后接进来（Electron 的 app）；本模块不直接引 electron，main 侧的服务在单元测试里
 * 也能加载，那时没有系统语言可读，按中文。
 */
import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'

let reported: Nullable<AppLocale> = null
let readSystemLanguage: () => string | undefined = () => undefined
const listeners = new Set<() => void>()

export function isWorkbenchAppLocale(value: unknown): value is AppLocale {
  return value === 'en-US' || value === 'zh-CN'
}

/** main 入口在应用就绪后告诉这里怎么读系统语言（如 `zh-Hans-CN`、`en-US`）。 */
export function setWorkbenchSystemLanguageSource(read: () => string | undefined): void {
  readSystemLanguage = read
}

export function getWorkbenchMainLocale(): AppLocale {
  if (reported) return reported
  const language = readSystemLanguage()
  if (language === undefined) return 'zh-CN'
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
