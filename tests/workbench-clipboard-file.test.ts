import { describe, expect, test } from 'bun:test'

import { resolveWorkbenchClipboardFilePath } from '../src/renderer/src/runtime/workbenchClipboardFile'

void describe('Workbench shared clipboard files', () => {
  void test('uses the native path for ordinary file picker attachments', () => {
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' })
    expect(resolveWorkbenchClipboardFilePath(file, () => '/tmp/native-notes.md')).toBe(
      '/tmp/native-notes.md'
    )
  })

  void test('uses shared clipboard path metadata for restored attachments', () => {
    const file = new File([], 'notes.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'path', { value: '/tmp/restored-notes.md' })

    expect(
      resolveWorkbenchClipboardFilePath(file, () => {
        throw new Error('synthetic files have no native drag handle')
      })
    ).toBe('/tmp/restored-notes.md')
  })
})
