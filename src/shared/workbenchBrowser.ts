/** Persistent Electron partition for the Workbench debug browser views. */
export const WorkbenchBrowserPartition = 'persist:velaros-workbench-browser'

/**
 * Workbench Browser 的最终加载边界。地址栏可以先把搜索词展开为 URL，但在任何
 * `loadURL` / runtime 导航前都必须再经过这里，避免 `file:` 或特权协议进入 guest。
 */
export function normalizeWorkbenchBrowserPageUrl(
  rawUrl: string,
  options: { allowAboutBlank?: boolean } = {}
): string | null {
  if (typeof rawUrl !== 'string' || containsControlCharacter(rawUrl)) return null
  const candidate = rawUrl.trim()
  if (!candidate) return null
  if (candidate === 'about:blank') return options.allowAboutBlank === false ? null : candidate

  try {
    const url = new URL(candidate)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}
