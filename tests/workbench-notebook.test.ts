import { describe, expect, test } from 'bun:test'

import type { RuntimeNoteContent, WorkspaceEntry } from '@velaros-ai/velaros'

import { readWorkbenchNotebook } from '../src/renderer/src/runtime/conversation/readWorkbenchNotebook'
import type { WorkbenchConversationBridge } from '../src/shared/workbenchConversation'

const Ref = { projectRoot: '/project', sessionId: 'session' }
const entry = (key: string, chars: number, revision = 1): WorkspaceEntry => ({
  key,
  chars,
  revision,
  title: key,
  resident: true,
  ref: { sessionId: Ref.sessionId, id: `${key}-${revision}` },
})

describe('Workbench notebook reads', () => {
  test('reads all catalog and body pages, reuses the same revision and refreshes residency', async () => {
    const body = `${'x'.repeat(32000)}tail`
    const a = entry('a', body.length)
    const b = entry('b', 6)
    const pages: number[] = []
    const cached: RuntimeNoteContent = { entry: b, text: 'cached', offset: 0, totalChars: 6 }
    const reader: Pick<WorkbenchConversationBridge, 'listNotes' | 'readNote'> = {
      listNotes: async (request) => ({
        ok: true,
        value: request.after
          ? { items: [{ ...b, resident: false }], nextAfter: null }
          : { items: [a], nextAfter: 'a' },
      }),
      readNote: async (request) => {
        expect(request.key).toBe('a')
        pages.push(request.offset ?? 0)
        return {
          ok: true,
          value: {
            entry: a,
            text: body.slice(request.offset, (request.offset ?? 0) + (request.limit ?? 32000)),
            offset: request.offset ?? 0,
            totalChars: body.length,
          },
        }
      },
    }
    const result = await readWorkbenchNotebook(reader, Ref, [cached], new AbortController().signal)
    expect(result.map((note) => note.text)).toEqual([body, 'cached'])
    expect(result[1]!.entry.resident).toBe(false)
    expect(pages).toEqual([0, 32000])
  })

  test('surfaces missing data and rejects repeated cursors instead of loading forever', async () => {
    const reader: Pick<WorkbenchConversationBridge, 'listNotes' | 'readNote'> = {
      listNotes: async () => ({ ok: true, value: { items: [entry('a', 10)], nextAfter: 'a' } }),
      readNote: async () => ({ ok: false, message: 'unavailable' }),
    }
    await expect(
      readWorkbenchNotebook(reader, Ref, [], new AbortController().signal)
    ).rejects.toThrow('分页不连续')
    reader.listNotes = async () => ({
      ok: true,
      value: { items: [entry('a', 10)], nextAfter: null },
    })
    await expect(
      readWorkbenchNotebook(reader, Ref, [], new AbortController().signal)
    ).rejects.toThrow('unavailable')
  })

  test('a session switch cancels an old read before it can update the new notebook', async () => {
    const controller = new AbortController()
    const reader: Pick<WorkbenchConversationBridge, 'listNotes' | 'readNote'> = {
      listNotes: async () => {
        controller.abort()
        return { ok: true, value: { items: [entry('a', 1)], nextAfter: null } }
      },
      readNote: async () => {
        throw new Error('must not read a stale session')
      },
    }
    await expect(readWorkbenchNotebook(reader, Ref, [], controller.signal)).rejects.toThrow()
  })
})
