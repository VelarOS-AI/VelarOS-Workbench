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
  /**
   * 预览标签（名字是斜体）：下一次以预览方式打开别的文件时，新文件顶替它而不是再加一个标签。一组最多
   * 一个；没有为 null。
   */
  readonly previewPath: Nullable<string>
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

const EmptyWorkbenchEditorGroup: WorkbenchEditorGroup = {
  paths: [],
  previewPath: null,
  activePath: null,
}

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

/** 从界面上打开一个文件时，它的标签怎么开。 */
export interface WorkbenchEditorOpenTabIntent {
  /**
   * 以预览标签打开（单击文件、点搜索结果、跳到定义）。文件已经开着时只是切过去，它是不是预览都不变——点
   * 标签也是这样切的。不给就是普通打开（双击、回车、快速打开）：开着的预览标签就此留下。
   */
  preview?: boolean
  /** 这次打开是从当前文件跳过去的（跳到定义、引用）：当前文件是预览标签的话先留下，不让目标顶替它。 */
  keepSource?: boolean
}

export interface WorkbenchEditorOpenTabOptions {
  /**
   * 以预览标签打开：新文件顶替这一组已有的预览标签（没有就在末尾加一个）。文件已经开着时只是切过去，它是
   * 不是预览都不变——普通标签不会变回预览。不给（普通打开）时，已经开着的预览标签就此留下。
   */
  preview?: boolean
  /** 新标签放进哪一组；不给就是当前组。文件已经在某一组里开着时不看它。 */
  groupIndex?: number
}

export interface WorkbenchEditorOpenTabResult {
  layout: WorkbenchEditorGroupsLayout
  /** 被这次预览顶替掉的那个预览标签：它已经不在布局里，调用方要把它的文件一起关掉。没有为 null。 */
  replacedPath: Nullable<string>
}

/**
 * 打开一个文件的标签并切过去。已经开着的就在它所在的那一组切过去（那一组成为当前组）；没开着的在目标组里
 * 加一个标签：普通标签加在标签栏末尾，预览标签顶替原来的预览标签、占它的位置。
 */
export function openWorkbenchEditorTab(
  layout: WorkbenchEditorGroupsLayout,
  path: string,
  options: WorkbenchEditorOpenTabOptions = {}
): WorkbenchEditorOpenTabResult {
  const existingIndex = findWorkbenchEditorGroupIndex(layout, path)
  if (existingIndex >= 0) {
    const group = layout.groups[existingIndex]!
    const keeps = !options.preview && group.previewPath === path
    if (group.activePath === path && layout.focusedGroup === existingIndex && !keeps)
      return { layout, replacedPath: null }

    const nextGroup = { ...group, activePath: path, previewPath: keeps ? null : group.previewPath }
    return {
      layout: { ...replaceGroup(layout, existingIndex, nextGroup), focusedGroup: existingIndex },
      replacedPath: null,
    }
  }

  const targetIndex = Math.min(
    Math.max(0, options.groupIndex ?? layout.focusedGroup),
    layout.groups.length - 1
  )
  const group = layout.groups[targetIndex] ?? EmptyWorkbenchEditorGroup
  const replacedPath = options.preview ? group.previewPath : null
  const nextGroup: WorkbenchEditorGroup = {
    paths: replacedPath
      ? group.paths.map((current) => (current === replacedPath ? path : current))
      : [...group.paths, path],
    previewPath: options.preview ? path : group.previewPath,
    activePath: path,
  }
  return {
    layout: { ...replaceGroup(layout, targetIndex, nextGroup), focusedGroup: targetIndex },
    replacedPath,
  }
}

/** 把预览标签留下，变成普通标签（编辑、保存、双击标签、拖动之后）；本来就不是预览的不变。 */
export function keepWorkbenchEditorTab(
  layout: WorkbenchEditorGroupsLayout,
  path: string
): WorkbenchEditorGroupsLayout {
  const groupIndex = layout.groups.findIndex((group) => group.previewPath === path)
  const group = layout.groups[groupIndex]
  return group ? replaceGroup(layout, groupIndex, { ...group, previewPath: null }) : layout
}

/** 所有预览标签都留下（关掉预览标签这项设置的时候）。 */
export function keepWorkbenchEditorPreviewTabs(
  layout: WorkbenchEditorGroupsLayout
): WorkbenchEditorGroupsLayout {
  if (!layout.groups.some((group) => group.previewPath)) return layout
  return { ...layout, groups: layout.groups.map((group) => ({ ...group, previewPath: null })) }
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
            previewPath:
              group.previewPath && closing.has(group.previewPath) ? null : group.previewPath,
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

/** 拖动标签：把 `fromPath` 挪到同一组里 `toPath` 现在的位置上；拖的是预览标签就把它留下。 */
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
  return replaceGroup(layout, groupIndex, {
    ...group,
    paths,
    previewPath: group.previewPath === fromPath ? null : group.previewPath,
  })
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
    const previewPath = group.previewPath ? rename(group.previewPath) : null
    const activePath = group.activePath ? rename(group.activePath) : null
    return {
      paths,
      previewPath: previewPath && paths.includes(previewPath) ? previewPath : null,
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

  const previewPath = readString(value.previewPath)
  const activePath = readString(value.activePath)
  return {
    paths,
    previewPath: previewPath && paths.includes(previewPath) ? previewPath : null,
    activePath: activePath && paths.includes(activePath) ? activePath : paths[0]!,
  }
}

/**
 * 校验存下来的布局：认不出的整体当成没有标签；重复的路径、超出 `maxTabs` 的标签、不在标签栏里的当前
 * 标签与预览标签都按缺省值收拾好。
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
