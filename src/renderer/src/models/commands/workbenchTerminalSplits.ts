/**
 * 终端的拆分：一个标签里可以并排放几个终端。会话仍是一张平表，并排的几个挨在一起、共用一个组号；标签栏上
 * 一组一个标签，面板里把当前那一组从左到右排开。
 */
import type { WorkbenchTerminalSessionView } from './workbenchCommandLines'

/** 标签栏上的一个标签：并排显示的一组终端（没拆分过就一个）。 */
export interface WorkbenchTerminalGroup {
  id: string
  sessions: WorkbenchTerminalSessionView[]
}

/** 并排的终端里，一个至少占这么大的份额（按全宽算），拖分隔条时不会被挤没。 */
export const MinWorkbenchTerminalPaneShare = 0.1

export function workbenchTerminalGroupId(session: WorkbenchTerminalSessionView): string {
  return session.groupId ?? session.id
}

function paneWeight(session: WorkbenchTerminalSessionView): number {
  return session.paneWeight ?? 1
}

/** 按标签栏的顺序分组（一组在表里第一次出现的位置就是它的位置）。 */
export function groupWorkbenchTerminalSessions(
  sessions: readonly WorkbenchTerminalSessionView[]
): WorkbenchTerminalGroup[] {
  const groups = new Map<string, WorkbenchTerminalGroup>()
  for (const session of sessions) {
    const id = workbenchTerminalGroupId(session)
    const group = groups.get(id)
    if (group) group.sessions.push(session)
    else groups.set(id, { id, sessions: [session] })
  }
  return [...groups.values()]
}

/** 当前终端所在的那一组；没有当前终端（或它已经不在了）给第一组。 */
export function findActiveWorkbenchTerminalGroup(
  sessions: readonly WorkbenchTerminalSessionView[],
  activeSessionId: Nullable<string>
): Nullable<WorkbenchTerminalGroup> {
  const groups = groupWorkbenchTerminalSessions(sessions)
  return (
    groups.find((group) => group.sessions.some((session) => session.id === activeSessionId)) ??
    groups[0] ??
    null
  )
}

/**
 * 把新起的会话放到 `besideSessionId` 的右边、同一组里：原来那个让出一半宽度给它。原来那个已经不在了就当成
 * 一个新标签放到最后。
 */
export function insertWorkbenchTerminalSplit(
  sessions: readonly WorkbenchTerminalSessionView[],
  besideSessionId: string,
  session: WorkbenchTerminalSessionView
): WorkbenchTerminalSessionView[] {
  const index = sessions.findIndex((candidate) => candidate.id === besideSessionId)
  const beside = sessions[index]
  if (!beside) return [...sessions, session]

  const half = paneWeight(beside) / 2
  return [
    ...sessions.slice(0, index),
    { ...beside, paneWeight: half },
    { ...session, groupId: workbenchTerminalGroupId(beside), paneWeight: half },
    ...sessions.slice(index + 1),
  ]
}

/**
 * 关掉几个会话之后哪个成为当前终端：当前的没被关就不变；否则先找同一组里剩下的（右边的，没有就左边的），
 * 整组都关了就到左边那个标签，再没有就右边那个；一个都不剩给 null。
 */
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
  const groupId = workbenchTerminalGroupId(active)
  const inGroup = (session: WorkbenchTerminalSessionView): boolean =>
    workbenchTerminalGroupId(session) === groupId && survives(session)
  const after = sessions.slice(activeIndex + 1)
  const before = sessions.slice(0, activeIndex).reverse()
  const next =
    after.find(inGroup) ?? before.find(inGroup) ?? before.find(survives) ?? after.find(survives)
  return { sessions: remaining, activeSessionId: next?.id ?? null }
}

/** 同一组里左边（-1）或右边（1）的那个终端，到头了绕回另一头；组里只有一个时给 null。 */
export function adjacentWorkbenchTerminalPane(
  sessions: readonly WorkbenchTerminalSessionView[],
  activeSessionId: Nullable<string>,
  direction: 1 | -1
): Nullable<string> {
  const group = findActiveWorkbenchTerminalGroup(sessions, activeSessionId)
  if (!group || group.sessions.length < 2) return null
  const index = group.sessions.findIndex((session) => session.id === activeSessionId)
  if (index < 0) return null
  const count = group.sessions.length
  return group.sessions[(index + direction + count) % count]!.id
}

/** 一组里各个终端占全宽的比例（加起来是 1）。 */
export function workbenchTerminalPaneShares(
  sessions: readonly WorkbenchTerminalSessionView[]
): number[] {
  const total = sessions.reduce((sum, session) => sum + paneWeight(session), 0)
  return sessions.map((session) => paneWeight(session) / total)
}

/**
 * 拖第 `divider` 条分隔线（它左边是第 `divider` 个、右边是第 `divider + 1` 个）：左边的多出 `delta`
 * （占全宽的比例，负数是往左拖），右边的相应少掉；两边都不会小于 {@link MinWorkbenchTerminalPaneShare}。
 */
export function resizeWorkbenchTerminalPanes(
  shares: readonly number[],
  divider: number,
  delta: number
): number[] {
  const left = shares[divider]
  const right = shares[divider + 1]
  if (left === undefined || right === undefined) return [...shares]

  const pair = left + right
  const min = Math.min(MinWorkbenchTerminalPaneShare, pair / 2)
  const nextLeft = Math.min(pair - min, Math.max(min, left + delta))
  return shares.map((share, index) =>
    index === divider ? nextLeft : index === divider + 1 ? pair - nextLeft : share
  )
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

/** 焦点在终端里时的按键动作：拆分、在并排的终端之间换焦点。 */
export type WorkbenchTerminalPaneAction = 'split' | 'focus-previous' | 'focus-next'

interface WorkbenchTerminalKeyLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** 拆分的快捷键（与全局快捷键同一种写法，界面提示用）：macOS 上 ⌘D，其它平台 Ctrl+Shift+5。 */
export function workbenchTerminalSplitShortcut(isApple: boolean): string {
  return isApple ? 'Mod+D' : 'Ctrl+Shift+5'
}

/**
 * 终端里按下的键是不是这几个动作。macOS：⌘D 拆分，⌥⌘← / ⌥⌘→ 换到左边 / 右边那个；其它平台：Ctrl+Shift+5
 * 拆分，Alt+← / Alt+→ 换焦点。按物理键认，不受输入法和键盘布局影响。
 */
export function matchWorkbenchTerminalPaneKey(
  event: WorkbenchTerminalKeyLike,
  isApple: boolean
): Nullable<WorkbenchTerminalPaneAction> {
  const { code, metaKey, ctrlKey, altKey, shiftKey } = event
  const arrow = code === 'ArrowLeft' ? 'focus-previous' : code === 'ArrowRight' ? 'focus-next' : null

  if (isApple) {
    if (!metaKey || ctrlKey || shiftKey) return null
    if (altKey) return arrow
    return code === 'KeyD' ? 'split' : null
  }
  if (metaKey) return null
  if (ctrlKey && shiftKey && !altKey && code === 'Digit5') return 'split'
  return altKey && !ctrlKey && !shiftKey ? arrow : null
}
