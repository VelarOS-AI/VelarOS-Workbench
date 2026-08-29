import type { Completion } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Custom Completion field for the right-aligned return type column. */
export const WORKBENCH_COMPLETION_RETURN_TYPE = 'workbenchReturnType'
export const WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS = 35
export const WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS = 30

export interface WorkbenchCompletionPresentation extends Completion {
  [WORKBENCH_COMPLETION_RETURN_TYPE]?: string
}

export function readWorkbenchCompletionReturnType(
  completion: Completion
): string | undefined {
  return (completion as WorkbenchCompletionPresentation)[WORKBENCH_COMPLETION_RETURN_TYPE]
}

export function workbenchCompletionOptionClass(completion: Completion): string {
  const kind = completion.type?.split(/\s+/)[0] ?? 'text'
  return `cm-workbenchCompletionOption cm-workbenchCompletionOption-${kind}`
}

export const workbenchCompletionAddToOptions: Array<{
  render: (completion: Completion, state: EditorState, view: EditorView) => Node | null
  position: number
}> = [
  {
    position: 100,
    render(completion) {
      const returnType = readWorkbenchCompletionReturnType(completion)
      if (!returnType) return null

      const type = document.createElement('span')
      type.className = 'cm-workbenchCompletionType'
      type.textContent = returnType
      return type
    },
  },
]
