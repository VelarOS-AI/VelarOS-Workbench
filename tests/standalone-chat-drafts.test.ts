import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { type BrowserElementSelection } from '@velaros-ai/velaros/browser/contracts'

import {
  appendStandaloneChatContext,
  consumeStandaloneChatDraft,
  EmptyWorkbenchComposerContext,
  forgetStandaloneChatDraft,
  readStandaloneChatDraft,
  snapshotWorkbenchComposerContext,
  updateStandaloneChatDraft,
} from '../src/renderer/src/runtime/standaloneChatDrafts'

test('async submission clears only the original project chat and preserves another draft and its files', () => {
  const original = '/project-a\0chat'
  const next = '/project-a\0next-chat'
  const otherProject = '/project-b\0chat'
  const file = new File(['export const x = 1'], 'source.ts')
  updateStandaloneChatDraft(original, () => ({ value: 'original', files: [file] }))
  updateStandaloneChatDraft(next, () => ({ value: 'next draft', files: [file] }))
  updateStandaloneChatDraft(otherProject, () => ({ value: 'another project', files: [] }))
  updateStandaloneChatDraft(original, () => ({ value: '', files: [] }))
  assert.deepEqual(readStandaloneChatDraft(original), { value: '', files: [] })
  assert.deepEqual(readStandaloneChatDraft(next), { value: 'next draft', files: [file] })
  assert.equal(readStandaloneChatDraft(otherProject).value, 'another project')
  forgetStandaloneChatDraft(next)
  assert.equal(readStandaloneChatDraft(next).value, '')
  assert.equal(readStandaloneChatDraft(otherProject).value, 'another project')
  forgetStandaloneChatDraft(otherProject)
})

test('delayed editor and browser references remain in their original project chat', () => {
  const original = '/references-a\0chat'
  const next = '/references-a\0next'
  const otherProject = '/references-b\0chat'
  const selection = {
    id: 'picked-button',
    url: 'http://localhost:3000',
    label: 'Save',
    attributes: { id: 'save' },
  } as BrowserElementSelection
  updateStandaloneChatDraft(next, () => ({ value: 'next chat', files: [] }))
  appendStandaloneChatContext(original, {
    filePaths: ['src/save.ts'],
    browserSelections: [selection],
  })
  appendStandaloneChatContext(original, { filePaths: ['src/save.ts', 'src/index.ts'] })
  appendStandaloneChatContext(otherProject, { filePaths: ['other.ts'] })
  selection.attributes.id = 'changed-after-picking'
  assert.deepEqual(readStandaloneChatDraft(original).context?.selectedFileReferencePaths, [
    'src/save.ts',
    'src/index.ts',
  ])
  assert.equal(
    readStandaloneChatDraft(original).context?.browserSelections[0]?.attributes.id,
    'save'
  )
  assert.equal(readStandaloneChatDraft(next).context, undefined)
  assert.deepEqual(readStandaloneChatDraft(otherProject).context?.selectedFileReferencePaths, [
    'other.ts',
  ])
  for (const scope of [original, next, otherProject]) forgetStandaloneChatDraft(scope)
})

test('an async send consumes only its submitted text, attachments and references', () => {
  const scope = '/async-draft\0chat'
  const sentFile = new File(['sent'], 'sent.ts')
  const nextFile = new File(['next'], 'next.ts')
  const sentContext = snapshotWorkbenchComposerContext({
    ...EmptyWorkbenchComposerContext,
    selectedFileReferencePaths: ['sent.ts'],
    goalMode: true,
  })
  updateStandaloneChatDraft(scope, () => ({
    value: 'sent text',
    files: [sentFile],
    context: sentContext,
  }))
  updateStandaloneChatDraft(scope, (draft) => ({
    ...draft,
    value: 'new draft while attachment loads',
    files: [...draft.files, nextFile],
    context: { ...sentContext, selectedFileReferencePaths: ['sent.ts', 'next.ts'], planMode: true },
  }))
  consumeStandaloneChatDraft(scope, { value: 'sent text', files: [sentFile], context: sentContext })
  const remaining = readStandaloneChatDraft(scope)
  assert.equal(remaining.value, 'new draft while attachment loads')
  assert.deepEqual(remaining.files, [nextFile])
  assert.deepEqual(remaining.context?.selectedFileReferencePaths, ['next.ts'])
  assert.equal(remaining.context?.planMode, true)
  consumeStandaloneChatDraft(scope, {
    value: remaining.value,
    files: remaining.files,
    context: remaining.context!,
  })
  assert.equal(readStandaloneChatDraft(scope).value, '')
  assert.deepEqual(readStandaloneChatDraft(scope).files, [])
  assert.equal(readStandaloneChatDraft(scope).context?.goalMode, true)
  forgetStandaloneChatDraft(scope)
})
