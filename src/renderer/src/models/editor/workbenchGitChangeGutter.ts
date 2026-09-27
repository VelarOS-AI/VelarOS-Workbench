import {
  type EditorState,
  type Extension,
  Prec,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import {
  type BlockInfo,
  type EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { diffArrays } from 'diff'

/**
 * 贴着代码的 Git 改动标记（对照 HEAD）：新增的行一条绿线，改过的行一条青线，删掉的行在删除处画一个
 * 红色小三角。对照的是编辑器里的当前正文，没保存的改动也算。HEAD 里没有这个文件（新文件、不在版本库
 * 里）时不标：整个文件都是新的，文件树和标签已经上了色。
 *
 * HEAD 全文由上层读好后用 {@link setWorkbenchGitChangeBaseEffect} 送进来。打字时标记先跟着改动挪位置，
 * 最多隔 {@link RecomputeIntervalMs} 再按全文重新比对一次。
 */

export type WorkbenchGitLineChangeKind = 'added' | 'modified' | 'deleted'

/**
 * 一段连续改动，行号按当前文档（从 1 起）。
 * - added / modified：`fromLine..toLine` 这几行是新增 / 改过的。
 * - deleted：HEAD 里的行删在第 `fromLine` 行之后（0 = 文件开头之前）；`toLine` 与它相同。
 */
export interface WorkbenchGitLineChange {
  kind: WorkbenchGitLineChangeKind
  fromLine: number
  toLine: number
}

/** 标记在 gutter 里的样子：删除画在那一行的下边沿，删在文件开头时画在第一行的上边沿。 */
export type WorkbenchGitChangeMarkerKind = 'added' | 'modified' | 'deleted' | 'deleted-top'

/** 打字期间最多隔这么久按全文重新比对一次；中间标记只跟着改动挪位置。 */
const RecomputeIntervalMs = 120
/** 比对预算：中间那段改动超过这么多处编辑、或比对超时，就不再细分，整段按「改过」标。 */
const MaxEditLength = 4_000
const DiffTimeoutMs = 60

function normalizeCompareLines(lines: string[]): string[] {
  if (lines[0]?.startsWith('﻿')) lines[0] = lines[0].slice(1)
  // 末尾换行不单算一行：比的是行，文件末尾有没有换行不算改动。
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 比对用的行：去掉 BOM，按任意换行拆开，末尾换行不单算一行。 */
export function splitWorkbenchGitCompareLines(text: string): string[] {
  return normalizeCompareLines(text.split(/\r\n|\r|\n/u))
}

function documentCompareLines(doc: Text): string[] {
  return normalizeCompareLines(doc.toJSON())
}

function pushLineChange(
  changes: WorkbenchGitLineChange[],
  linesBefore: number,
  removedCount: number,
  addedCount: number
): void {
  if (addedCount === 0) {
    changes.push({ kind: 'deleted', fromLine: linesBefore, toLine: linesBefore })
    return
  }
  changes.push({
    kind: removedCount === 0 ? 'added' : 'modified',
    fromLine: linesBefore + 1,
    toLine: linesBefore + addedCount,
  })
}

/** 按行比出当前文档相对 HEAD 的改动段（两边都已是 {@link splitWorkbenchGitCompareLines} 的行）。 */
export function computeWorkbenchGitLineChanges(
  baseLines: readonly string[],
  currentLines: readonly string[]
): WorkbenchGitLineChange[] {
  // 首尾相同的行先剥掉：通常只剩改动附近一小段要比对。
  const sharedLength = Math.min(baseLines.length, currentLines.length)
  let prefix = 0
  while (prefix < sharedLength && baseLines[prefix] === currentLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < sharedLength - prefix &&
    baseLines[baseLines.length - 1 - suffix] === currentLines[currentLines.length - 1 - suffix]
  )
    suffix += 1

  const removed = baseLines.slice(prefix, baseLines.length - suffix)
  const added = currentLines.slice(prefix, currentLines.length - suffix)
  if (removed.length === 0 && added.length === 0) return []

  const changes: WorkbenchGitLineChange[] = []
  const parts =
    removed.length > 0 && added.length > 0
      ? diffArrays(removed, added, { timeout: DiffTimeoutMs, maxEditLength: MaxEditLength })
      : undefined
  if (!parts) {
    pushLineChange(changes, prefix, removed.length, added.length)
    return changes
  }

  let linesBefore = prefix
  let removedCount = 0
  let addedCount = 0
  for (const part of parts) {
    if (part.removed) {
      removedCount += part.value.length
    } else if (part.added) {
      addedCount += part.value.length
    } else {
      if (removedCount > 0 || addedCount > 0)
        pushLineChange(changes, linesBefore, removedCount, addedCount)
      linesBefore += addedCount + part.value.length
      removedCount = 0
      addedCount = 0
    }
  }
  if (removedCount > 0 || addedCount > 0)
    pushLineChange(changes, linesBefore, removedCount, addedCount)
  return changes
}

class WorkbenchGitChangeMarker extends GutterMarker {
  public constructor(public readonly kind: WorkbenchGitChangeMarkerKind) {
    super()
  }

  public override eq(other: GutterMarker): boolean {
    return other instanceof WorkbenchGitChangeMarker && other.kind === this.kind
  }

  public override toDOM(): Node {
    const mark = document.createElement('span')
    mark.className = `cm-workbenchGitChange cm-workbenchGitChange-${this.kind}`
    mark.setAttribute('aria-hidden', 'true')
    return mark
  }
}

const gitChangeMarkers: Record<WorkbenchGitChangeMarkerKind, WorkbenchGitChangeMarker> = {
  added: new WorkbenchGitChangeMarker('added'),
  modified: new WorkbenchGitChangeMarker('modified'),
  deleted: new WorkbenchGitChangeMarker('deleted'),
  'deleted-top': new WorkbenchGitChangeMarker('deleted-top'),
}

function buildGitChangeMarkers(
  doc: Text,
  changes: readonly WorkbenchGitLineChange[]
): RangeSet<GutterMarker> {
  const ranges: Array<Range<GutterMarker>> = []
  for (const change of changes) {
    if (change.kind === 'deleted') {
      const marker = change.fromLine === 0 ? gitChangeMarkers['deleted-top'] : gitChangeMarkers.deleted
      ranges.push(marker.range(doc.line(Math.max(1, change.fromLine)).from))
      continue
    }
    const marker = gitChangeMarkers[change.kind]
    for (let lineNumber = change.fromLine; lineNumber <= change.toLine; lineNumber += 1)
      ranges.push(marker.range(doc.line(lineNumber).from))
  }
  return RangeSet.of(ranges, true)
}

interface WorkbenchGitChangeFieldValue {
  /** HEAD 全文的比对行；null 表示这份文档不标 Git 改动。 */
  base: Nullable<readonly string[]>
  markers: RangeSet<GutterMarker>
  /** 文档改过、标记只是跟着挪了位置，还没按全文重新比对。 */
  stale: boolean
}

const EmptyGitChangeValue: WorkbenchGitChangeFieldValue = {
  base: null,
  markers: RangeSet.empty,
  stale: false,
}

/**
 * 换一份对照全文（HEAD 里这个文件的内容）：null 表示这份文档不标（新文件、不在版本库、读不到）。
 * 切文件时先送 null，别让上一个文件的 HEAD 拿来跟新文件比。
 */
export const setWorkbenchGitChangeBaseEffect = StateEffect.define<Nullable<string>>()

/** 按全文重新比对一次（打字停下来后由编辑器自己派发）。 */
export const recomputeWorkbenchGitChangesEffect = StateEffect.define<null>()

function recomputeGitChanges(
  state: EditorState,
  base: Nullable<readonly string[]>
): WorkbenchGitChangeFieldValue {
  if (!base) return EmptyGitChangeValue
  const changes = computeWorkbenchGitLineChanges(base, documentCompareLines(state.doc))
  return { base, markers: buildGitChangeMarkers(state.doc, changes), stale: false }
}

const workbenchGitChangeField = StateField.define<WorkbenchGitChangeFieldValue>({
  create: () => EmptyGitChangeValue,
  update(value, tr) {
    let base = value.base
    let recompute = false
    for (const effect of tr.effects) {
      if (effect.is(setWorkbenchGitChangeBaseEffect)) {
        base = effect.value === null ? null : splitWorkbenchGitCompareLines(effect.value)
        recompute = true
      } else if (effect.is(recomputeWorkbenchGitChangesEffect)) {
        recompute = true
      }
    }
    if (recompute) return recomputeGitChanges(tr.state, base)
    if (!tr.docChanged || !value.base) return value
    return { ...value, markers: value.markers.map(tr.changes), stale: true }
  },
})

const workbenchGitChangeRecompute = ViewPlugin.fromClass(
  class {
    private timer: Nullable<ReturnType<typeof setTimeout>> = null

    public constructor(private readonly view: EditorView) {}

    public update(update: ViewUpdate): void {
      if (this.timer !== null || !update.state.field(workbenchGitChangeField).stale) return
      this.timer = setTimeout(() => {
        this.timer = null
        if (!this.view.state.field(workbenchGitChangeField).stale) return
        this.view.dispatch({ effects: recomputeWorkbenchGitChangesEffect.of(null) })
      }, RecomputeIntervalMs)
    }

    public destroy(): void {
      if (this.timer !== null) clearTimeout(this.timer)
    }
  }
)

/** 当前的改动标记（行号 + 样子），按行号排好。 */
export function collectWorkbenchGitChangeMarkers(
  state: EditorState
): Array<{ line: number; kind: WorkbenchGitChangeMarkerKind }> {
  const value = state.field(workbenchGitChangeField, false)
  if (!value) return []

  const markers: Array<{ line: number; kind: WorkbenchGitChangeMarkerKind }> = []
  value.markers.between(0, state.doc.length, (from, _to, marker) => {
    if (marker instanceof WorkbenchGitChangeMarker)
      markers.push({ line: state.doc.lineAt(from).number, kind: marker.kind })
  })
  return markers
}

/**
 * 折叠起来的一段（`from..to`，比如打开文件时自动折起的 import 块）里藏着的改动该怎么画在折叠行上：
 * 只有一种改动时照它画，混着几种时按「改过」画；不是折叠行、或里面没有改动时为 null。
 */
export function resolveWorkbenchFoldedGitChangeKind(
  state: EditorState,
  from: number,
  to: number
): Nullable<WorkbenchGitChangeMarkerKind> {
  if (to <= state.doc.lineAt(from).to) return null

  const kinds = new Set<WorkbenchGitChangeMarkerKind>()
  state.field(workbenchGitChangeField).markers.between(from + 1, to, (markerFrom, _to, marker) => {
    if (markerFrom > from && marker instanceof WorkbenchGitChangeMarker) kinds.add(marker.kind)
    return kinds.size > 1 ? false : undefined
  })
  const [onlyKind] = kinds
  if (!onlyKind) return null
  return kinds.size === 1 ? onlyKind : 'modified'
}

function foldedGitChangeMarker(
  view: EditorView,
  block: BlockInfo,
  markersAtBlockStart: readonly GutterMarker[]
): Nullable<GutterMarker> {
  // 同一行上还可能有只带 class 的标记（当前行高亮之类），只看自己的。
  if (markersAtBlockStart.some((marker) => marker instanceof WorkbenchGitChangeMarker)) return null
  const kind = resolveWorkbenchFoldedGitChangeKind(view.state, block.from, block.to)
  return kind ? gitChangeMarkers[kind] : null
}

export const workbenchGitChangeGutterExtension: Extension = [
  workbenchGitChangeField,
  workbenchGitChangeRecompute,
  // 最低优先级：排在所有栏（行号、折叠、运行按钮）之后，紧挨着代码。
  Prec.lowest(
    gutter({
      class: 'cm-workbenchGitChangeGutter',
      markers: (view) => view.state.field(workbenchGitChangeField).markers,
      lineMarker: foldedGitChangeMarker,
      lineMarkerChange: (update) =>
        update.startState.field(workbenchGitChangeField) !==
        update.state.field(workbenchGitChangeField),
    })
  ),
]
