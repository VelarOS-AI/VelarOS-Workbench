import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { WorkbenchChatRunChangeStore } from '../src/main/workspace/git/WorkbenchChatRunChanges'

test('stores commit patches outside the project and isolates session records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-commit-records-'))
  try {
    const store = new WorkbenchChatRunChangeStore(
      () => join(root, 'data'),
      () => 20
    )
    const ref = { workspaceRoot: join(root, 'project'), sessionId: 'session-a' }
    const changes = [
      {
        path: 'a.txt',
        status: 'modified' as const,
        additions: 2,
        deletions: 2,
        binary: false,
        patches: ['first commit patch', 'second commit patch'],
        patchOmitted: false,
        statsOmitted: false,
      },
    ]
    const { recordId, ...summary } = await store.write(ref, changes, 0)
    assert.deepEqual(summary, {
      capturedAt: 20,
      fileCount: 1,
      additions: 2,
      deletions: 2,
      statsOmitted: false,
      error: null,
    })
    const request = { ...ref, recordId }
    assert.deepEqual(await store.read(request), { recordId, capturedAt: 20, changes })
    assert.equal(await store.read({ ...request, sessionId: 'session-b' }), null)
    await store.delete({ ...ref, recordIds: [recordId] })
    assert.equal(await store.read(request), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
