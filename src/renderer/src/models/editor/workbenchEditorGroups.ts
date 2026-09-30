import { isArray } from '@velaros-ai/core'
import {
  isRecord,
  readNumberScalar as readNumber,
  readStringScalar as readString,
} from '@velaros-ai/core/utils/unknownJsonRecord'

import { resolveWorkbenchEditorSelectionAfterClose } from './workbenchEditorTabClose'

/**
 * 编辑区的标签布局：哪些文件开着标签、在标签栏上怎么排、每一组显示哪个、全局动作落在哪一组。
 *
 * 这里只认路径：文件的正文与磁盘快照在 `useWorkbenchEditorController` 的 `openTabsByPath` 里，两边的路径
 * 始终是同一批。都是纯函数，返回新的布局；没有变化时返回原来那个对象。一个文件同一时刻只在一组里有标签。
 * 这份布局原样随项目会话存盘（见 workbenchProjectSessionModel）。
 */

/** 一个编辑器组的标签栏。 */
export interface WorkbenchEditorGroup {
  /** 标签栏顺序的文件路径。 */
  readonly paths: readonly string[]
  /** 这一组当前显示的标签；组里没有标签时为 null。 */
  readonly activePath: Nullable<string>
}

export interface WorkbenchEditorGroupsLayout {
  /** 从左到右的组；至少有一组（没有标签时是一个空组）。 */
  readonly groups: readonly WorkbenchEditorGroup[]
  /** 全局动作（保存、查找、跳行……）作用的那一组在 `groups` 里的下标。 */
  readonly focusedGroup: number
}

/** 编辑区里最多有几组。 */
const MaxWorkbenchEditorGroups = 1

const EmptyWorkbenchEditorGroup: WorkbenchEditorGroup = { paths: [], activePath: null }

export function createWorkbenchEditorGroupsLayout(): WorkbenchEditorGroupsLayout {
  return { groups: [EmptyWorkbenchEditorGroup], focusedGroup: 0 }
}

/** 所有开着的标签：按组从左到右，组内按标签栏顺序。 */
export function listWorkbenchEditorLayoutPaths(layout: WorkbenchEditorGroupsLayout): string[] {
  return layout.groups.flatMap((group) => group.paths)
}

/** 这个文件的标签在哪一组；没开着返回 -1。 */
export function findWorkbenchEditorGroupIndex(
  layout: WorkbenchEditorGroupsLayout,
  path: string
): number {
  return layout.groups.findIndex((group) => group.paths.includes(path))
}

export function getWorkbenchEditorFocusedGroup(
  layout: WorkbenchEditorGroupsLayout
): WorkbenchEditorGroup {
  return layout.groups[layout.focusedGroup] ?? layout.groups[0] ?? EmptyWorkbenchEditorGroup
}

/** 「当前文件」：全局动作所在那一组正在显示的标签。 */
export function getWorkbenchEditorFocusedPath(layout: WorkbenchEditorGroupsLayout): Nullable<string> {
  return getWorkbenchEditorFocusedGroup(layout).activePath
}

function replaceGroup(
  layout: WorkbenchEditorGroupsLayout,
  index: number,
  group: WorkbenchEditorGroup
): WorkbenchEditorGroupsLayout {
  return {
    ...layout,
    groups: layout.groups.map((current, groupIndex) => (groupIndex === index ? group : current)),
  }
}

/** 没有标签的组不留着（只剩一个空组除外）；当前组被收掉时落到留下来的组上。 */
function collapseEmptyGroups(layout: WorkbenchEditorGroupsLayout): WorkbenchEditorGroupsLayout {
  const kept = layout.groups.flatMap((group, index) => (group.paths.length > 0 ? [{ group, index }] : []))
  if (kept.length === layout.groups.length) return layout
  if (kept.length === 0) return { ...layout, groups: [EmptyWorkbenchEditorGroup], focusedGroup: 0 }

  const focused = kept.findIndex((item) => item.index === layout.focusedGroup)
  return {
    ...layout,
    groups: kept.map((item) => item.group),
    focusedGroup: focused >= 0 ? focused : Math.min(layout.focusedGroup, kept.length - 1),
  }
}

export interface WorkbenchEditorOpenTabOptions {
  /** 新标签放进哪一组；不给就是当前组。文件已经在某一组里开着时不看它。 */
  groupIndex?: number
}

/**
 * 打开一个文件的标签并切过去。已经开着的就在它所在的那一组切过去（那一组成为当前组）；没开着的在目标组的
 * 标签栏末尾加一个。
 */
export function openWorkbenchEditorTab(
  layout: WorkbenchEditorGroupsLayout,
  path: string,
  options: WorkbenchEditorOpenTabOptions = {}
): WorkbenchEditorGroupsLayout {
  const existingIndex = findWorkbenchEditorGroupIndex(layout, path)
  if (existingIndex >= 0) {
    const group = layout.groups[existingIndex]!
    if (group.activePath === path && layout.focusedGroup === existingIndex) return layout
    return { ...replaceGroup(layout, existingIndex, { ...group, activePath: path }), focusedGroup: existingIndex }
  }

  const targetIndex = Math.min(
    Math.max(0, options.groupIndex ?? layout.focusedGroup),
    layout.groups.length - 1
  )
  const group = layout.groups[targetIndex] ?? EmptyWorkbenchEditorGroup
  return {
    ...replaceGroup(layout, targetIndex, { paths: [...group.paths, path], activePath: path }),
    focusedGroup: targetIndex,
  }
}

/**
 * 关掉一批标签。每一组各自按 `resolveWorkbenchEditorSelectionAfterClose` 选好接下来显示哪个；关空了的组
 * 不留着。
 */
export function closeWorkbenchEditorTabs(
  layout: WorkbenchEditorGroupsLayout,
  closingPaths: Iterable<string>
): WorkbenchEditorGroupsLayout {
  const closing = new Set(closingPaths)
  if (!layout.groups.some((group) => group.paths.some((path) => closing.has(path)))) return layout

  return collapseEmptyGroups({
    ...layout,
    groups: layout.groups.map((group) =>
      group.paths.some((path) => closing.has(path))
        ? {
            paths: group.paths.filter((path) => !closing.has(path)),
            activePath: resolveWorkbenchEditorSelectionAfterClose(
              group.paths,
              closing,
              group.activePath
            ),
          }
        : group
    ),
  })
}

/** 拖动标签：把 `fromPath` 挪到同一组里 `toPath` 现在的位置上。 */
export function reorderWorkbenchEditorTab(
  layout: WorkbenchEditorGroupsLayout,
  fromPath: string,
  toPath: string
): WorkbenchEditorGroupsLayout {
  if (fromPath === toPath) return layout
  const groupIndex = findWorkbenchEditorGroupIndex(layout, fromPath)
  const group = layout.groups[groupIndex]
  if (!group) return layout

  const fromIndex = group.paths.indexOf(fromPath)
  const toIndex = group.paths.indexOf(toPath)
  if (toIndex < 0 || fromIndex === toIndex) return layout

  const paths = group.paths.filter((path) => path !== fromPath)
  paths.splice(toIndex, 0, fromPath)
  return replaceGroup(layout, groupIndex, { ...group, paths })
}

/**
 * 文件或目录改了名、挪了地方：标签跟着换成新路径，位置不变。换完撞上另一个已经开着的路径时只留前面
 * 那个标签。
 */
export function renameWorkbenchEditorLayoutPaths(
  layout: WorkbenchEditorGroupsLayout,
  rename: (path: string) => string
): WorkbenchEditorGroupsLayout {
  const seen = new Set<string>()
  let changed = false
  const groups = layout.groups.map((group) => {
    const paths: string[] = []
    for (const path of group.paths) {
      const renamed = rename(path)
      if (renamed !== path) changed = true
      if (seen.has(renamed)) continue
      seen.add(renamed)
      paths.push(renamed)
    }
    const activePath = group.activePath ? rename(group.activePath) : null
    return {
      paths,
      activePath: activePath && paths.includes(activePath) ? activePath : (paths[0] ?? null),
    }
  })
  return changed ? collapseEmptyGroups({ ...layout, groups }) : layout
}

function normalizeGroup(
  value: unknown,
  seen: Set<string>,
  remaining: number
): Nullable<WorkbenchEditorGroup> {
  if (!isRecord(value) || !isArray(value.paths)) return null

  const paths: string[] = []
  for (const item of value.paths) {
    if (paths.length >= remaining) break
    const path = readString(item)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  if (paths.length === 0) return null

  const activePath = readString(value.activePath)
  return { paths, activePath: activePath && paths.includes(activePath) ? activePath : paths[0]! }
}

/**
 * 校验存下来的布局：认不出的整体当成没有标签；重复的路径、超出 `maxTabs` 的标签、不在标签栏里的当前
 * 标签都按缺省值收拾好。
 */
export function normalizeWorkbenchEditorGroupsLayout(
  value: unknown,
  maxTabs: number
): WorkbenchEditorGroupsLayout {
  if (!isRecord(value) || !isArray(value.groups)) return createWorkbenchEditorGroupsLayout()

  const seen = new Set<string>()
  const groups: WorkbenchEditorGroup[] = []
  for (const item of value.groups) {
    if (groups.length >= MaxWorkbenchEditorGroups) break
    const group = normalizeGroup(item, seen, maxTabs - seen.size)
    if (group) groups.push(group)
  }
  if (groups.length === 0) return createWorkbenchEditorGroupsLayout()

  const focusedGroup = readNumber(value.focusedGroup)
  return {
    groups,
    focusedGroup:
      focusedGroup !== null && Number.isInteger(focusedGroup) && focusedGroup >= 0 && focusedGroup < groups.length
        ? focusedGroup
        : 0,
  }
}
