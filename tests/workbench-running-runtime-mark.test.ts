import assert from 'node:assert/strict'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import {
  ConversationRenderSlotsProvider,
  useConversationRenderSlots,
} from '@velaros-ai/ui/conversation'

import type { WorkbenchChatProviderId } from '../src/plugins/agent-engines/identity'
import {
  type WorkbenchChatCompositionAdapter,
  WorkbenchChatProvider,
  WorkbenchChatSessionSurface,
} from '../src/renderer/src/composition/WorkbenchChatProvider'
import { standaloneWorkbenchConversationRenderSlots } from '../src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots'

function RuntimeMarkProbe(): Nullable<ReactElement> {
  const slots = useConversationRenderSlots()
  return slots.runningRuntimeMark?.({ sessionId: 'test-session' }) ?? null
}

const adapter: WorkbenchChatCompositionAdapter = {
  useProjectRuntime: () => {
    throw new Error('RuntimeMarkProbe does not read project runtime')
  },
  SessionSurface: RuntimeMarkProbe,
}

function renderRuntimeMark(providerId: WorkbenchChatProviderId): string {
  return renderToStaticMarkup(
    createElement(
      ConversationRenderSlotsProvider,
      { slots: standaloneWorkbenchConversationRenderSlots },
      createElement(
        WorkbenchChatProvider,
        { adapter },
        createElement(WorkbenchChatSessionSurface, {
          providerId,
          projectRoot: '/test/project',
          currentFilePath: null,
          conversationRefreshKey: 0,
          pendingBrowserElementSelections: [],
        })
      )
    )
  )
}

void describe('Workbench running runtime mark', () => {
  void test('uses the Velar sail for the native Workbench agent', () => {
    const markup = renderRuntimeMark('workbench')

    assert.match(markup, /data-workbench-running-runtime-mark="workbench"/u)
    assert.match(markup, /viewBox="12 4 31 28"/u)
    assert.doesNotMatch(markup, /viewBox="0 0 24 24"/u)
  })

  void test('uses each external agent engine brand mark', () => {
    const codexMarkup = renderRuntimeMark('codex')
    const claudeMarkup = renderRuntimeMark('claude-code')

    assert.match(codexMarkup, /data-workbench-running-runtime-mark="codex"/u)
    assert.match(claudeMarkup, /data-workbench-running-runtime-mark="claude-code"/u)
    assert.match(codexMarkup, /viewBox="0 0 24 24"/u)
    assert.match(claudeMarkup, /viewBox="0 0 24 24"/u)
    assert.notEqual(codexMarkup, claudeMarkup)
    assert.doesNotMatch(codexMarkup, /viewBox="12 4 31 28"/u)
    assert.doesNotMatch(claudeMarkup, /viewBox="12 4 31 28"/u)
  })

  void test('returns no asserted brand when a chat surface identity is absent', () => {
    const markup = renderToStaticMarkup(
      createElement(
        ConversationRenderSlotsProvider,
        { slots: standaloneWorkbenchConversationRenderSlots },
        createElement(RuntimeMarkProbe)
      )
    )

    assert.equal(markup, '')
  })
})
