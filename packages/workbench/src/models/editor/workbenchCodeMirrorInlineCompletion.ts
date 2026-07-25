import type { Extension } from '@codemirror/state'
import { Prec, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

import { isBlank } from '@velaros/core'

/**
 * 编辑器 Tab 内联补全（Cursor 式 ghost text）。
 *
 * 用户停顿后，向 runtime 请求一段补全，以灰色虚影展示在光标处；Tab 接受、Esc 取消，
 * 任意继续输入都会清掉当前建议。模型解析/请求全在主进程完成，这里只负责触发、展示与接受。
 */

/** 停顿多久（ms）后才发起补全请求，避免每个字符都打一次模型。 */
const InlineCompletionDebounceMs = 300

export interface WorkbenchInlineCompletionRuntime {
  /** 是否启用补全（编辑器设置里的开关，实时读取）。 */
  isEnabled: () => boolean
  /** 向主进程请求补全；返回要插入的文本，无建议时返回 null。 */
  request: (context: { prefix: string; suffix: string }) => Promise<string | null>
}

interface InlineSuggestionState {
  text: string
  pos: number
}

const setInlineSuggestionEffect = StateEffect.define<InlineSuggestionState | null>()

class InlineSuggestionWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  public eq(other: InlineSuggestionWidget): boolean {
    return other.text === this.text
  }

  public toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-workbench-inline-suggestion'
    // white-space: pre 在样式里；这里直接塞多行文本即可。
    span.textContent = this.text
    return span
  }

  public ignoreEvent(): boolean {
    return false
  }
}

function buildSuggestionDecorations(value: InlineSuggestionState | null): DecorationSet {
  if (!value || !value.text) return Decoration.none

  return Decoration.set([
    Decoration.widget({
      widget: new InlineSuggestionWidget(value.text),
      side: 1,
    }).range(value.pos),
  ])
}

const inlineSuggestionField = StateField.define<InlineSuggestionState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setInlineSuggestionEffect)) return effect.value
    }
    // 任何文档改动或选区移动都作废当前建议（接受操作会自带清空 effect，先于此处命中）。
    if (tr.docChanged || tr.selection) return null

    return value
  },
  provide: (field) => EditorView.decorations.from(field, buildSuggestionDecorations),
})

function currentSuggestion(view: EditorView): InlineSuggestionState | null {
  return view.state.field(inlineSuggestionField, false) ?? null
}

/** Tab：光标仍在建议位置时插入补全文本。 */
function acceptInlineSuggestion(view: EditorView): boolean {
  const suggestion = currentSuggestion(view)
  if (!suggestion || !suggestion.text) return false

  const head = view.state.selection.main.head
  if (head !== suggestion.pos) return false

  view.dispatch({
    changes: { from: suggestion.pos, insert: suggestion.text },
    selection: { anchor: suggestion.pos + suggestion.text.length },
    effects: setInlineSuggestionEffect.of(null),
    userEvent: 'input.complete',
  })
  return true
}

/** Esc：清掉当前建议。 */
function dismissInlineSuggestion(view: EditorView): boolean {
  if (!currentSuggestion(view)) return false

  view.dispatch({ effects: setInlineSuggestionEffect.of(null) })
  return true
}

const inlineSuggestionKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptInlineSuggestion },
    { key: 'Escape', run: dismissInlineSuggestion },
  ])
)

const inlineSuggestionTheme = EditorView.baseTheme({
  '.cm-workbench-inline-suggestion': {
    color: 'var(--workbench-editor-ghost, #9aa0aa)',
    opacity: '0.7',
    fontStyle: 'italic',
    whiteSpace: 'pre',
    display: 'inline-block',
    verticalAlign: 'top',
    pointerEvents: 'none',
  },
})

function buildInlineSuggestionPlugin(runtime: WorkbenchInlineCompletionRuntime): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null
      /** 单调递增的请求令牌，用来丢弃过期（已被新输入取代）的补全响应。 */
      private token = 0

      constructor(private readonly view: EditorView) {}

      public update(update: ViewUpdate): void {
        if (!update.docChanged) return

        // 只对用户真实输入/删除触发，跳过外部同步、程序化写入和接受补全本身。
        const userTyped = update.transactions.some(
          (tr) => tr.isUserEvent('input.type') || tr.isUserEvent('delete')
        )
        if (!userTyped) return

        this.schedule()
      }

      private schedule(): void {
        this.clearTimer()
        if (!runtime.isEnabled()) return

        this.timer = setTimeout(() => {
          this.timer = null
          void this.run()
        }, InlineCompletionDebounceMs)
      }

      private clearTimer(): void {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
      }

      private async run(): Promise<void> {
        if (!runtime.isEnabled()) return

        const state = this.view.state
        const selection = state.selection.main
        if (!selection.empty) return

        const pos = selection.head
        if (pos <= 0) return

        const prefix = state.sliceDoc(0, pos)
        const suffix = state.sliceDoc(pos, state.doc.length)
        const requestToken = ++this.token

        let text: string | null = null
        try {
          text = await runtime.request({ prefix, suffix })
        } catch {
          // 补全是纯锦上添花能力，请求失败就当没有建议，绝不打断编辑。
          text = null
        }

        // 期间又输入了/换了模型/光标移动了，丢弃这次结果。
        if (requestToken !== this.token) return
        if (this.view.state.selection.main.head !== pos) return
        if (!text || isBlank(text)) return

        // 建议开头与光标后文完全一致时没意义（模型只是把后文复述了一遍）。
        if (suffix.startsWith(text)) return

        this.view.dispatch({ effects: setInlineSuggestionEffect.of({ text, pos }) })
      }

      public destroy(): void {
        this.clearTimer()
      }
    }
  )
}

/** 组装内联补全扩展。runtime 提供实时的启用状态与请求实现。 */
export function workbenchInlineCompletionExtension(
  runtime: WorkbenchInlineCompletionRuntime
): Extension {
  return [
    inlineSuggestionField,
    inlineSuggestionKeymap,
    inlineSuggestionTheme,
    buildInlineSuggestionPlugin(runtime),
  ]
}
