import assert from 'node:assert/strict'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

const { ConversationRenderSlotsProvider, useConversationRenderSlots } = await import(
  '@velaros-ai/ui/conversation'
)
const {
  WorkbenchChatProvider,
  WorkbenchChatSessionSurface,
} = await import('../src/renderer/src/composition/WorkbenchChatProvider')
const { standaloneWorkbenchConversationRenderSlots } = await import(
  '../src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots'
)

function RuntimeMarkProbe(): Nullable<ReactElement> {
  const slots = useConversationRenderSlots()
  return slots.runningRuntimeMark?.({ sessionId: 'test-session' }) ?? null
}

function renderWithSlots(child: ReactElement): string {
  return renderToStaticMarkup(
    createElement(ConversationRenderSlotsProvider, {
      slots: standaloneWorkbenchConversationRenderSlots,
      children: child,
    })
  )
}

void describe('Workbench running runtime mark', () => {
  void test('uses the Velar sail for the Workbench agent inside a chat surface', () => {
    const markup = renderWithSlots(
      createElement(WorkbenchChatProvider, {
        adapter: {
          useProjectRuntime: () => {
            throw new Error('RuntimeMarkProbe does not read project runtime')
          },
          SessionSurface: RuntimeMarkProbe,
        },
        children: createElement(WorkbenchChatSessionSurface, {
          projectRoot: '/test/project',
          currentFilePath: null,
          conversationRefreshKey: 0,
          pendingBrowserElementSelections: [],
          pendingFileReferences: [],
        }),
      })
    )

    assert.match(markup, /data-workbench-running-runtime-mark="workbench"/u)
    assert.match(markup, /viewBox="12 4 31 28"/u)
    assert.doesNotMatch(markup, /viewBox="0 0 24 24"/u)
  })

  void test('needs no chat surface identity: every Workbench run is a Platform run', () => {
    const markup = renderWithSlots(createElement(RuntimeMarkProbe))

    assert.match(markup, /data-workbench-running-runtime-mark="workbench"/u)
    assert.match(markup, /viewBox="12 4 31 28"/u)
  })
})
