import type { WorkbenchTerminalSessionView } from './workbenchCommandLines'

export function buildWorkbenchTerminalSessionTitle(
  sessionIndex: number,
  labels: { local: string; localIndexed: (index: number) => string }
): string {
  if (sessionIndex <= 0) return labels.local

  return labels.localIndexed(sessionIndex + 1)
}

/**
 * 新标签叫什么：按「本地、本地 (2)、本地 (3)……」找第一个没人用的（中间的关掉了，新开的补上那个号）。
 */
export function pickWorkbenchTerminalTitle(
  sessions: readonly WorkbenchTerminalSessionView[],
  titleAt: (index: number) => string
): string {
  const used = new Set(sessions.map((session) => session.title))
  for (let index = 0; index < sessions.length; index += 1) {
    const title = titleAt(index)
    if (!used.has(title)) return title
  }
  return titleAt(sessions.length)
}

/** 关闭当前标签后选中左侧仍在的标签；左侧没有时选右侧。 */
export function closeWorkbenchTerminalSessions(
  sessions: readonly WorkbenchTerminalSessionView[],
  activeSessionId: Nullable<string>,
  closingSessionIds: readonly string[]
): { sessions: WorkbenchTerminalSessionView[]; activeSessionId: Nullable<string> } {
  const closing = new Set(closingSessionIds)
  const remaining = sessions.filter((session) => !closing.has(session.id))
  const activeIndex = sessions.findIndex((session) => session.id === activeSessionId)
  const active = sessions[activeIndex]
  if (!active) return { sessions: remaining, activeSessionId: remaining.at(-1)?.id ?? null }
  if (!closing.has(active.id)) return { sessions: remaining, activeSessionId: active.id }

  const survives = (session: WorkbenchTerminalSessionView): boolean => !closing.has(session.id)
  const next =
    sessions.slice(0, activeIndex).reverse().find(survives) ??
    sessions.slice(activeIndex + 1).find(survives)
  return { sessions: remaining, activeSessionId: next?.id ?? null }
}
