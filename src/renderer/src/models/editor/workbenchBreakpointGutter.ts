/**
 * 行号上的断点：在 JavaScript / TypeScript 文件里点行号下一个断点（红点），再点一下摘掉。断点存在编辑器之外
 * （按项目存着，重启还在，见 `models/debug/workbenchBreakpoints.ts`），这里只管把它画在行号上、跟着编辑挪位置：
 * - 编辑器里的断点是一组跟着文档变化挪动的位置：上面插了几行，断点跟着下去，挪完把新的行号写回存储；
 * - 存储在别处变了，这里照着改；
 * - 调试中，正在跑的程序里对不上代码的断点画成空心的。
 *
 * 存储与调试状态由调用方给（读、写、订阅），这个模块不认识它们。
 */
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  gutterLineClass,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

import { workbenchLineNumberClickFacet } from './workbenchCodeMirrorLineNumberSelection'
import { registerWorkbenchEditorActions } from './workbenchEditorActions'

export interface WorkbenchBreakpointGutterOptions {
  /** 这个文件此刻存着的断点行（从 1 起）。 */
  readLines: () => readonly number[]
  /** 编辑器里的断点行变了（点了行号，或者编辑让断点挪了行）：把这个文件此刻的断点行整份写回。 */
  writeLines: (lines: number[]) => void
  /** 存储里的断点变了就通知。 */
  subscribeLines: (listener: () => void) => () => void
  /** 这一行的断点在正在跑的程序里对没对上代码；没在调试（或者还不知道）为 null。 */
  readVerified: (line: number) => Nullable<boolean>
  /** 调试状态变了（开始、结束、断点重新对过）就通知。 */
  subscribeVerified: (listener: () => void) => () => void
}

class WorkbenchBreakpointMarker extends GutterMarker {
  /**
   * 在断点所在的位置（行首）插入内容时，断点算在插入内容的后面：在行首回车，断点跟着原来那一行的内容到下一行，
   * 不留在新插出来的空行上。（在行首打字时位置离开了行首，由断点字段挪回去。）
   */
  public override startSide = 1
  public override endSide = 1

  public constructor(public override elementClass: string) {
    super()
  }

  public override eq(other: GutterMarker): boolean {
    return other instanceof WorkbenchBreakpointMarker && other.elementClass === this.elementClass
  }
}

const breakpointMarker = new WorkbenchBreakpointMarker('cm-workbenchBreakpointGutterLine')
const unverifiedBreakpointMarker = new WorkbenchBreakpointMarker(
  'cm-workbenchBreakpointGutterLine cm-workbenchBreakpointUnverified'
)
const breakpointLine = Decoration.line({ class: 'cm-workbenchBreakpointLine' })

/** 在这一行下 / 摘断点（行号从 1 起）。 */
export const toggleWorkbenchEditorBreakpoint = StateEffect.define<number>()
/** 整份换成这些行（存储在别处变了）。 */
export const setWorkbenchEditorBreakpointLines = StateEffect.define<readonly number[]>()
/** 调试状态变了：断点的「没对上」要重画。 */
const refreshBreakpointStatus = StateEffect.define<null>()

function lineStart(state: EditorState, line: number): number {
  return state.doc.line(Math.min(Math.max(1, line), state.doc.lines)).from
}

function positionsOf(state: EditorState, lines: readonly number[]): RangeSet<GutterMarker> {
  const positions = [...new Set(lines.map((line) => lineStart(state, line)))].sort(
    (left, right) => left - right
  )
  return RangeSet.of(positions.map((position) => breakpointMarker.range(position)))
}

function collectLines(state: EditorState, positions: RangeSet<GutterMarker>): number[] {
  const lines: number[] = []
  const cursor = positions.iter()
  while (cursor.value) {
    const line = state.doc.lineAt(Math.min(cursor.from, state.doc.length)).number
    if (lines.at(-1) !== line) lines.push(line)
    cursor.next()
  }
  return lines
}

function sameLines(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

/** 断点在文档里的位置（各在所在行的行首）。只说「哪几行有断点」，画成什么样另算。 */
const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(positions, transaction) {
    let next = positions
    if (transaction.docChanged && positions.size > 0) {
      // 断点跟着它所在的行走。所在的行被并进了别的行时位置不在行首了：挪回行首，同一行上的并成一个。
      const mapped = positions.map(transaction.changes)
      const lines = collectLines(transaction.state, mapped)
      next =
        lines.length === mapped.size && isAtLineStarts(transaction.state, mapped)
          ? mapped
          : positionsOf(transaction.state, lines)
    }
    for (const effect of transaction.effects) {
      if (effect.is(setWorkbenchEditorBreakpointLines)) next = positionsOf(transaction.state, effect.value)
      if (!effect.is(toggleWorkbenchEditorBreakpoint)) continue

      const position = lineStart(transaction.state, effect.value)
      let exists = false
      next.between(position, position, () => {
        exists = true
      })
      next = exists
        ? next.update({ filter: (from) => from !== position })
        : next.update({ add: [breakpointMarker.range(position)] })
    }
    return next
  },
})

function isAtLineStarts(state: EditorState, positions: RangeSet<GutterMarker>): boolean {
  const cursor = positions.iter()
  while (cursor.value) {
    if (state.doc.lineAt(cursor.from).from !== cursor.from) return false
    cursor.next()
  }
  return true
}

/** 每收到一次「调试状态变了」加一：画断点的那一栏据此重算。 */
const breakpointStatusVersion = StateField.define<number>({
  create: () => 0,
  update: (version, transaction) =>
    transaction.effects.some((effect) => effect.is(refreshBreakpointStatus)) ? version + 1 : version,
})

/** 这个编辑器状态里下了断点的行号（从 1 起，升序）；没挂断点扩展的是空的。 */
export function readWorkbenchEditorBreakpointLines(state: EditorState): number[] {
  const positions = state.field(breakpointField, false)
  return positions ? collectLines(state, positions) : []
}

export function createWorkbenchBreakpointGutterExtension(
  options: WorkbenchBreakpointGutterOptions
): Extension {
  const toggleAt = (view: EditorView, line: number): void => {
    view.dispatch({ effects: toggleWorkbenchEditorBreakpoint.of(line), userEvent: 'gutter.breakpoint.toggle' })
  }

  const sync = ViewPlugin.fromClass(
    class {
      private readonly unsubscribeLines: () => void
      private readonly unsubscribeVerified: () => void
      private readonly unregisterActions: () => void
      /** 正在把编辑器里的行号写回存储：这时存储的通知是自己引起的，不用再照着改一遍。 */
      private writing = false
      private destroyed = false

      public constructor(private readonly view: EditorView) {
        this.unsubscribeLines = options.subscribeLines(() => {
          if (!this.writing) this.pull()
        })
        this.unsubscribeVerified = options.subscribeVerified(() => {
          if (!this.destroyed) view.dispatch({ effects: refreshBreakpointStatus.of(null) })
        })
        // 命令面板里的「切换断点」：在光标那一行。
        this.unregisterActions = registerWorkbenchEditorActions(view, {
          'toggle-breakpoint': () =>
            toggleAt(view, view.state.doc.lineAt(view.state.selection.main.head).number),
        })
        // 这份状态可能是早先建的（切走又切回来的文件），期间存储变过。构造时不能派发事务，排到后面做。
        queueMicrotask(() => this.pull())
      }

      public update(update: ViewUpdate): void {
        const before = update.startState.field(breakpointField, false)
        if (before === update.state.field(breakpointField, false)) return

        const lines = readWorkbenchEditorBreakpointLines(update.state)
        // 照着存储改的（或者这次变化之后正好与存储一致）不用写回；点行号、编辑挪了行的写回存储。
        if (sameLines(lines, options.readLines())) return
        const pulled = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setWorkbenchEditorBreakpointLines))
        )
        if (pulled) return

        this.writing = true
        try {
          options.writeLines(lines)
        } finally {
          this.writing = false
        }
      }

      public destroy(): void {
        this.destroyed = true
        this.unsubscribeLines()
        this.unsubscribeVerified()
        this.unregisterActions()
      }

      /** 存储里的断点行与编辑器里的不一样：照存储的改。 */
      private pull(): void {
        if (this.destroyed) return
        const stored = options.readLines()
        if (sameLines(stored, readWorkbenchEditorBreakpointLines(this.view.state))) return
        this.view.dispatch({ effects: setWorkbenchEditorBreakpointLines.of(stored) })
      }
    }
  )

  return [
    // 状态刚建的时候（打开文件、挪到另一组的编辑器里重建）从存储里取这个文件的断点。
    breakpointField.init((state) => positionsOf(state, options.readLines())),
    breakpointStatusVersion,
    sync,
    // 行号上的红点；调试中没对上代码的画成空心。
    gutterLineClass.compute([breakpointField, breakpointStatusVersion], (state) => {
      const ranges: Array<Range<GutterMarker>> = []
      const cursor = state.field(breakpointField).iter()
      while (cursor.value) {
        const verified = options.readVerified(state.doc.lineAt(cursor.from).number)
        ranges.push(
          (verified === false ? unverifiedBreakpointMarker : breakpointMarker).range(cursor.from)
        )
        cursor.next()
      }
      return RangeSet.of(ranges)
    }),
    // 有断点的行铺一层很淡的底色。
    EditorView.decorations.compute([breakpointField], (state) => {
      const ranges: Array<Range<Decoration>> = []
      const cursor = state.field(breakpointField).iter()
      while (cursor.value) {
        ranges.push(breakpointLine.range(cursor.from))
        cursor.next()
      }
      return Decoration.set(ranges)
    }),
    // 行号上的点击归断点（不再打那个只在本地的标记）。
    workbenchLineNumberClickFacet.of((view, line) => {
      toggleAt(view, line)
      return true
    }),
  ]
}
