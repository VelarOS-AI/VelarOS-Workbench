import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { EmptyWorkbenchComposerContext } from '../src/renderer/src/runtime/standaloneChatDrafts'
import { sendWorkbenchComposerDraft } from '../src/renderer/src/runtime/standaloneComposerSubmission'
import { StandaloneQueuedDraftStore } from '../src/renderer/src/runtime/standaloneQueuedDrafts'

function fixture() {
  const store = new StandaloneQueuedDraftStore()
  const sent: string[] = []
  const answered: string[] = []
  let clears = 0
  const options: Parameters<typeof sendWorkbenchComposerDraft>[0] = {
    value: 'follow up',
    files: [new File(['attachment'], 'note.txt')],
    context: {
      ...EmptyWorkbenchComposerContext,
      selectedFileReferencePaths: ['src/main.ts'],
    },
    answering: false,
    canEnqueue: true,
    answer: async (value) => {
      answered.push(value)
    },
    enqueue: (draft) => {
      store.enqueue('session', draft)
    },
    clear: () => {
      clears += 1
    },
    submit: async (value) => {
      sent.push(value)
    },
  }
  return {
    store,
    options,
    sent,
    answered,
    get clears() {
      return clears
    },
  }
}

test('running sends queue the clicked draft and keep files and context until explicit delivery', async () => {
  const f = fixture()
  f.options.draft = { value: 'latest draft', files: f.options.files }
  await sendWorkbenchComposerDraft(f.options)
  assert.deepEqual(f.sent, [])
  const item = f.store.snapshot('session').drafts[0]!
  assert.equal(item.value, 'latest draft')
  assert.deepEqual(item.files, f.options.files)
  assert.deepEqual(item.context?.selectedFileReferencePaths, ['src/main.ts'])
  assert.equal(f.clears, 1)
  await f.store.drain('session', { busy: true, paused: false }, async () =>
    assert.fail('still running')
  )
  await f.store.submit('session', item.id, async (draft) => {
    f.sent.push(draft.value)
    return true
  })
  assert.deepEqual(f.sent, ['latest draft'])
  assert.equal(f.store.snapshot('session').drafts.length, 0)
})

test('failed or stopped runs retain the queue until the user sends an item', async () => {
  const f = fixture()
  await sendWorkbenchComposerDraft(f.options)
  const item = f.store.snapshot('session').drafts[0]!
  await f.store.drain('session', { busy: false, paused: true }, async () =>
    assert.fail('must wait')
  )
  await f.store.submit('session', item.id, async () => false)
  await f.store.drain('session', { busy: false, paused: false }, async () =>
    assert.fail('no retry loop')
  )
  assert.equal(f.store.snapshot('session').drafts[0], item)
  await f.store.submit('session', item.id, async () => true)
  assert.equal(f.store.snapshot('session').drafts.length, 0)
})

test('answers bypass the queue and idle messages submit normally', async () => {
  const f = fixture()
  f.options.answering = true
  await sendWorkbenchComposerDraft(f.options)
  assert.deepEqual(f.answered, ['follow up'])
  assert.equal(f.store.snapshot('session').drafts.length, 0)
  f.options.answering = false
  f.options.canEnqueue = false
  await sendWorkbenchComposerDraft(f.options)
  assert.deepEqual(f.sent, ['follow up'])
  assert.equal(f.clears, 0)
})
