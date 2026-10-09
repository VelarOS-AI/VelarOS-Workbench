import type { ChatInputSendDraft } from '@velaros-ai/ui/conversation/composer'

import type { WorkbenchComposerContext } from './standaloneChatDrafts'

interface ComposerSubmissionOptions {
  draft?: ChatInputSendDraft
  value: string
  files: File[]
  context: WorkbenchComposerContext
  answering: boolean
  canEnqueue: boolean
  answer: (value: string) => Promise<void>
  enqueue: (draft: { value: string; files: File[]; context: WorkbenchComposerContext }) => void
  clear: () => void
  submit: (value: string, files: File[]) => Promise<void>
}

/** 输入框只负责回答、排队或空闲提交；运行中的即时引导由队列项触发。 */
export function sendWorkbenchComposerDraft(options: ComposerSubmissionOptions): Promise<void> {
  const value = options.draft?.value ?? options.value
  const files = options.draft?.files ?? options.files
  if (options.answering) return options.answer(value)
  if (!options.canEnqueue) return options.submit(value, files)
  if (
    !value.trim() &&
    files.length === 0 &&
    options.context.browserSelections.length === 0 &&
    options.context.selectedFileReferencePaths.length === 0
  )
    return Promise.resolve()
  options.enqueue({ value, files, context: options.context })
  options.clear()
  return Promise.resolve()
}
