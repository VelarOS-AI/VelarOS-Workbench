import {
  acceptCompletion,
  closeCompletion,
  type Completion,
  type CompletionContext,
  type CompletionInfo,
  type CompletionResult,
  type CompletionSource,
  completionStatus,
  currentCompletions,
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { type EditorState, Prec } from '@codemirror/state'
import { Direction, EditorView, keymap } from '@codemirror/view'

import type { WorkbenchLanguageServiceDisplayPart } from '@shared/contracts/workbench'

import { appendWorkbenchEditorHoverText, type WorkbenchEditorHoverPartStyle } from './workbenchEditorHoverHighlight'

/** Custom Completion field for the right-aligned return type column. */
export const WORKBENCH_COMPLETION_RETURN_TYPE = 'workbenchReturnType'
export const WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS = 200
export const WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS = 30

function closeVisibleCompletion(view: EditorView): void {
  if (completionStatus(view.state) === 'active' || currentCompletions(view.state).length > 0)
    closeCompletion(view)
}

export const workbenchHideCompletionWhileTyping = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        // A CodeMirror delete command can handle keydown before the browser sends beforeinput.
        if (completionStatus(view.state) !== null) closeCompletion(view)
        return false
      }
      const typing =
        event.key.length === 1 &&
        !event.metaKey &&
        ((!event.ctrlKey && !event.altKey) || event.getModifierState('AltGraph'))
      if (typing) closeVisibleCompletion(view)
      return false
    },
    beforeinput(event, view) {
      if (event.inputType.startsWith('insert') || event.inputType.startsWith('delete'))
        closeVisibleCompletion(view)
      return false
    },
  })
)

export interface WorkbenchCompletionPresentation extends Completion {
  [WORKBENCH_COMPLETION_RETURN_TYPE]?: string
  workbenchSource?: string
  workbenchDeprecated?: boolean
  hideWhenAlreadyTyped?: boolean
}

export const workbenchCompletionKeys = Prec.high(keymap.of([{ key: 'Tab', run: acceptCompletion }]))

export function isWorkbenchJavaScriptMemberCompletion({ state, pos }: Pick<CompletionContext, 'state' | 'pos'>): boolean {
  const { from } = state.doc.lineAt(pos)
  return /(?<!\.)\.[ \t]*[\p{ID_Continue}$]*$/u.test(state.sliceDoc(Math.max(from, pos - 256), pos))
}

export function hideUnchangedWorkbenchCompletions(source: CompletionSource): CompletionSource {
  return (context: CompletionContext) => {
    if (!context.explicit) {
      const node = syntaxTree(context.state).resolveInner(context.pos, -1)
      if (
        node.to === context.pos &&
        (node.name === 'break' || node.name === 'continue' || node.name === 'debugger')
      )
        return null
    }
    const filter = (result: CompletionResult | null): CompletionResult | null => {
      if (!result || context.explicit) return result
      const typed = context.state.sliceDoc(result.from, result.to ?? context.pos)
      if (!typed) return result
      const options = result.options.filter((option: WorkbenchCompletionPresentation) => {
        if (option.label !== typed) return true
        return !(option.hideWhenAlreadyTyped || (option.apply ?? option.label) === typed)
      })
      return options.length ? { ...result, options } : null
    }
    const result = source(context)
    return result instanceof Promise ? result.then(filter) : filter(result)
  }
}

export function readWorkbenchCompletionReturnType(
  completion: Completion
): string | undefined {
  return (completion as WorkbenchCompletionPresentation)[WORKBENCH_COMPLETION_RETURN_TYPE]
}

export function workbenchCompletionOptionClass(completion: Completion): string {
  const item: WorkbenchCompletionPresentation = completion
  return item.workbenchDeprecated ? 'cm-workbenchCompletionOption cm-workbenchCompletionDeprecated' : 'cm-workbenchCompletionOption'
}

export const workbenchCompletionAddToOptions: Array<{
  render: (completion: Completion, state: EditorState, view: EditorView) => Node | null
  position: number
}> = [
  {
    position: 100,
    render(completion: WorkbenchCompletionPresentation, _state, view) {
      const returnType = readWorkbenchCompletionReturnType(completion)
      const metadata = returnType || completion.workbenchSource
      if (!metadata) return null

      const node = view.dom.ownerDocument.createElement('span')
      node.className = returnType ? 'cm-workbenchCompletionType' : 'cm-workbenchCompletionSource'
      node.textContent = metadata
      return node
    },
  },
]

interface WorkbenchCompletionPreview {
  signature?: string
  signatureParts?: readonly WorkbenchLanguageServiceDisplayPart[]
  documentation?: string
  source?: string
}

function appendCompletionCode(container: HTMLElement, fallbackText: string, parts?: readonly WorkbenchLanguageServiceDisplayPart[]): void {
  appendWorkbenchEditorHoverText(container, {
    parts,
    fallbackText,
    partClassName: (role: WorkbenchEditorHoverPartStyle) => `cm-workbenchCompletionToken-${role}`,
  })
}

function appendCompletionDocumentation(parent: HTMLElement, text: string): void {
  const doc = parent.ownerDocument
  const inline = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/gu
  let cursor = 0
  for (const match of text.matchAll(inline)) {
    parent.append(text.slice(cursor, match.index))
    const [, label, url, bold, literal] = match
    if (url && label) {
      const anchor = doc.createElement('a')
      anchor.href = url
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      anchor.textContent = label
      anchor.addEventListener('mousedown', (event) => event.preventDefault())
      parent.append(anchor)
    } else if (bold) {
      const strong = doc.createElement('strong')
      appendCompletionDocumentation(strong, bold)
      parent.append(strong)
    } else {
      const code = doc.createElement('code')
      appendCompletionCode(code, literal ?? '')
      parent.append(code)
    }
    cursor = match.index + match[0].length
  }
  parent.append(text.slice(cursor))
}

function appendCompletionDocumentationBlocks(container: HTMLElement, text: string): void {
  const blocks = /^```[^\n]*\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gmu
  let cursor = 0
  for (const match of text.matchAll(blocks)) {
    appendCompletionDocumentation(container, text.slice(cursor, match.index))
    const code = container.ownerDocument.createElement('code')
    code.className = 'cm-workbenchCompletionCodeBlock'
    appendCompletionCode(code, (match[1] ?? '').trimEnd())
    container.append(code)
    cursor = match.index + match[0].length
  }
  appendCompletionDocumentation(container, text.slice(cursor))
}

/** The native tooltip destroys this preview when the selected item or the menu goes away. */
export function createWorkbenchCompletionInfo(
  preview: WorkbenchCompletionPreview,
  resolve?: () => Promise<WorkbenchCompletionPreview | null>
): CompletionInfo {
  const dom = document.createElement('div')
  dom.className = 'cm-workbenchCompletionPreview'
  dom.hidden = true
  let destroyed = false
  const show = async () => {
    const details = await resolve?.()
    if (destroyed) return
    const signature = details?.signature?.trim() || preview.signature?.trim()
    const documentation = details?.documentation?.trim() || preview.documentation?.trim()
    const source = details?.source || preview.source
    if (!signature && !documentation && !source) return

    if (signature) {
      const code = document.createElement('code')
      code.className = 'cm-workbenchCompletionSignature'
      appendCompletionCode(code, signature, details?.signatureParts)
      dom.append(code)
    }
    if (documentation) {
      const summary = document.createElement('div')
      summary.className = 'cm-workbenchCompletionDocumentation'
      appendCompletionDocumentationBlocks(summary, documentation)
      dom.append(summary)
    }
    if (source) {
      const origin = document.createElement('div')
      origin.className = 'cm-workbenchCompletionOrigin'
      origin.textContent = source
      dom.append(origin)
    }
    dom.hidden = false
  }
  const timer = setTimeout(() => void show(), 240)
  return { dom, destroy: () => { destroyed = true; clearTimeout(timer) } }
}

interface CompletionRect { left: number; right: number; top: number; bottom: number }

export function positionWorkbenchCompletionInfo(
  view: EditorView,
  list: CompletionRect,
  _option: CompletionRect,
  _info: CompletionRect,
  space: CompletionRect
): { style: string } {
  const gap = 6
  const left = (list.left - space.left) / view.scaleX - gap
  const right = (space.right - list.right) / view.scaleX - gap
  const preferRight = view.textDirection !== Direction.RTL
  const preferred = preferRight ? right : left
  const onRight = preferred >= 264 ? preferRight : right >= left
  const availableSide = onRight ? right : left
  if (availableSide >= 224) {
    const top = Math.max(list.top, space.top)
    const edge = onRight ? 'left' : 'right'
    return {
      style: `${edge}: calc(100% + ${gap}px); top: ${(top - list.top) / view.scaleY}px; width: ${Math.min(352, availableSide)}px; max-height: ${(space.bottom - top) / view.scaleY}px`,
    }
  }

  const above = (list.top - space.top) / view.scaleY - gap
  const below = (space.bottom - list.bottom) / view.scaleY - gap
  if (Math.max(above, below) < 70) return { style: 'display: none' }
  const edge = below >= above ? 'top' : 'bottom'
  return { style: `${edge}: calc(100% + ${gap}px); left: 0; width: 100%; max-height: ${Math.max(above, below)}px` }
}
