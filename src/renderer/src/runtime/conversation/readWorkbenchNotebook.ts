import { AppError } from '@velaros-ai/core/error'
import type { RuntimeNoteContent, WorkspaceEntry } from '@velaros-ai/velaros'

import type {
  WorkbenchConversationBridge,
  WorkbenchConversationSessionRequest,
} from '@shared/workbenchConversation'

/** 分页读取确定版本；旧版本缓存可复用，缺页与重复游标明确报错。 */
export async function readWorkbenchNotebook(
  reader: Pick<WorkbenchConversationBridge, 'listNotes' | 'readNote'>,
  ref: WorkbenchConversationSessionRequest,
  previous: readonly RuntimeNoteContent[],
  signal: AbortSignal
): Promise<RuntimeNoteContent[]> {
  const entries: WorkspaceEntry[] = []
  const cursors = new Set<string>()
  let after: string | undefined
  do {
    signal.throwIfAborted()
    const result = await reader.listNotes({ ...ref, after, limit: 64 })
    signal.throwIfAborted()
    if (!result.ok) throw new AppError('UNAVAILABLE', result.message)
    entries.push(...result.value.items)
    after = result.value.nextAfter ?? undefined
    if (after && cursors.has(after)) throw new AppError('PROTOCOL', '工作笔记目录分页不连续')
    if (after) cursors.add(after)
  } while (after)
  const notes: RuntimeNoteContent[] = []
  for (const entry of entries) {
    const cached = previous.find(
      (note) =>
        note.entry.ref.sessionId === entry.ref.sessionId &&
        note.entry.key === entry.key &&
        note.entry.revision === entry.revision
    )
    if (cached) {
      notes.push({ ...cached, entry })
      continue
    }
    let text = ''
    let totalChars = entry.chars
    do {
      signal.throwIfAborted()
      const result = await reader.readNote({
        ...ref,
        key: entry.key,
        revision: entry.revision,
        offset: text.length,
        limit: 32000,
      })
      signal.throwIfAborted()
      if (!result.ok) throw new AppError('UNAVAILABLE', result.message)
      const page = result.value
      if (
        !page ||
        page.offset !== text.length ||
        page.entry.revision !== entry.revision ||
        (!page.text && text.length < page.totalChars)
      )
        throw new AppError('PROTOCOL', '工作笔记正文分页不连续')
      text += page.text
      totalChars = page.totalChars
    } while (text.length < totalChars)
    notes.push({ entry, text, totalChars, offset: 0 })
  }
  return notes
}
