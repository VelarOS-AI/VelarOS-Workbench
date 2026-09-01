import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

void describe('Workbench chat composer parity', () => {
  void test('delegates side-surface presentation to the shared Platform composer', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    assert.match(adapter, /<ChatSurfaceComposer/)
    assert.match(adapter, /variant="side"/)
    assert.doesNotMatch(adapter, /<ChatComposer(?:\s|>)/)
    assert.doesNotMatch(adapter, /density="compact"/)
  })
})
