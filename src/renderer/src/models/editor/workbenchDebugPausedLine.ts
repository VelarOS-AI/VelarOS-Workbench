/**
 * 调试停下时，把程序停在的那一行标出来：整行铺底色，行首一道竖线。停在哪一行由调用方给（读、订阅），
 * 这个模块不认识调试会话。
 *
 * 用视图插件直接给装饰，不放进编辑器状态：切走又切回来的文件拿到的总是此刻的那一行，不会先闪一下旧的。
 */
import { type EditorState, type Extension, StateEffect } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

export interface WorkbenchDebugPausedLine {
  /** 行号，从 1 起。 */
  line: number
  /** 是不是调用栈最里层那一帧（程序真正停着的地方）；否则是面板里选中的外层一帧。 */
  topFrame: boolean
}

export interface WorkbenchDebugPausedLineOptions {
  /** 程序此刻停在这个文件的哪一行；没停在这个文件里为 null。 */
  readPausedLine: () => Nullable<WorkbenchDebugPausedLine>
  /** 停下、继续、换了选中的帧都通知。 */
  subscribe: (listener: () => void) => () => void
}

const pausedLine = Decoration.line({ class: 'cm-workbenchDebugPausedLine' })
const pausedFrameLine = Decoration.line({
  class: 'cm-workbenchDebugPausedLine cm-workbenchDebugPausedFrameLine',
})
const refreshPausedLine = StateEffect.define<null>()

function buildDecorations(
  state: EditorState,
  paused: Nullable<WorkbenchDebugPausedLine>
): DecorationSet {
  // 程序跑的是磁盘上那一版：文件在编辑器里被删短了，那一行可能已经不在了。
  if (!paused || paused.line < 1 || paused.line > state.doc.lines) return Decoration.none

  return Decoration.set([
    (paused.topFrame ? pausedLine : pausedFrameLine).range(state.doc.line(paused.line).from),
  ])
}

export function createWorkbenchDebugPausedLineExtension(
  options: WorkbenchDebugPausedLineOptions
): Extension {
  return ViewPlugin.fromClass(
    class {
      public decorations: DecorationSet
      private shown: Nullable<WorkbenchDebugPausedLine>
      private readonly unsubscribe: () => void
      private destroyed = false

      public constructor(view: EditorView) {
        this.shown = options.readPausedLine()
        this.decorations = buildDecorations(view.state, this.shown)
        this.unsubscribe = options.subscribe(() => {
          const next = options.readPausedLine()
          if (
            this.destroyed ||
            (next?.line === this.shown?.line && next?.topFrame === this.shown?.topFrame)
          )
            return
          // 装饰只在视图更新时换：派一个空事务。
          view.dispatch({ effects: refreshPausedLine.of(null) })
        })
      }

      public update(update: ViewUpdate): void {
        const refreshed = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshPausedLine))
        )
        if (!refreshed && !update.docChanged) return

        this.shown = options.readPausedLine()
        this.decorations = buildDecorations(update.state, this.shown)
      }

      public destroy(): void {
        this.destroyed = true
        this.unsubscribe()
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
