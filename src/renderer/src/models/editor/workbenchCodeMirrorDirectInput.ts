import { type Extension, Prec, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** Enter ordinary key text through the same handlers as native CodeMirror input. */
export const workbenchCodeMirrorDirectInput: Extension = Prec.high(
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      const { state } = view
      const text = event.data
      if (
        event.inputType !== 'insertText' || !event.cancelable || event.isComposing ||
        view.composing || state.readOnly || !state.facet(EditorView.editable) ||
        !text || !/^[\x20-\x7E]$/.test(text)
      ) return false

      // Native replacements (IME, spelling correction, and browser edits to a different range)
      // still go through CodeMirror's DOM observer.
      const targets = event.getTargetRanges()
      if (targets.length !== 1) return false
      const target = targets[0]
      const { from, to } = state.selection.main
      if (
        !view.contentDOM.contains(target.startContainer) || !view.contentDOM.contains(target.endContainer) ||
        view.posAtDOM(target.startContainer, target.startOffset) !== from ||
        view.posAtDOM(target.endContainer, target.endOffset) !== to
      ) return false

      let transaction: Transaction | undefined
      const insert = () => transaction ??= state.update(state.replaceSelection(text), {
        userEvent: 'input.type',
        scrollIntoView: true,
      })
      if (!state.facet(EditorView.inputHandler).some(handler => handler(view, from, to, text, insert)))
        view.dispatch(insert())
      return true
    },
  })
)
