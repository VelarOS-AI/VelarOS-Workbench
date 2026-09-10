import assert from 'node:assert/strict'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import {
  ConversationRenderSlotsProvider,
  useConversationRenderSlots,
} from '@velaros-ai/ui/conversation'

import { WorkbenchLocalizationProvider } from '../src/renderer/src/i18n'
import { standaloneWorkbenchConversationRenderSlots } from '../src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots'
import { WorkbenchRunChangesScopeContext } from '../src/renderer/src/runtime/conversation/WorkbenchRunChangesCard'
import type { WorkbenchChatRunChangesSummary } from '../src/shared/workbenchGit'

type SlotMessage = Parameters<
  ReturnType<typeof useConversationRenderSlots>['messageFileChangeSummary']
>[0]['message']

function SummaryProbe({ messageId }: { messageId: string }): Nullable<ReactElement> {
  const slots = useConversationRenderSlots()
  const message = { id: messageId, role: 'assistant', blocks: [], timestamp: 1 } as unknown as SlotMessage
  return slots.messageFileChangeSummary({
    message,
    sessionId: 'session',
    onReviewEntries: () => undefined,
  })
}

function renderCard(
  messageId: string,
  summaries: ReadonlyMap<string, WorkbenchChatRunChangesSummary>
): string {
  return renderToStaticMarkup(
    createElement(
      WorkbenchLocalizationProvider,
      {
        value: {
          locale: 'zh-CN',
          setLocale: async () => undefined,
          t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
        },
      },
      createElement(
        ConversationRenderSlotsProvider,
        { slots: standaloneWorkbenchConversationRenderSlots },
        createElement(
          WorkbenchRunChangesScopeContext.Provider,
          { value: { projectRoot: '/work/project', sessionId: 'session', summaries } },
          createElement(SummaryProbe, { messageId })
        )
      )
    )
  )
}

const Summary: WorkbenchChatRunChangesSummary = {
  recordId: 'checkpoint-1',
  capturedAt: 1,
  fileCount: 3,
  additions: 12,
  deletions: 4,
  error: null,
}

void describe('Workbench run changes card', () => {
  void test('heads the answer with the files and lines the run changed while the patches load', () => {
    const markup = renderCard('reply', new Map([['reply', Summary]]))

    assert.match(markup, /chat\.fileChangeSummaryFilesChanged\{&quot;count&quot;:3\}/u)
    assert.match(markup, />\+12</u)
    assert.match(markup, />-4</u)
    assert.match(markup, /chat\.fileChangeSummaryReview/u)
    // 补丁全文在主进程的记录文件里，挂出来之后才去读。
    assert.match(markup, /chat\.fileChangeSummaryLoading/u)
  })

  void test('stays out of answers whose run changed nothing, and says so when capture failed', () => {
    assert.equal(renderCard('other', new Map([['reply', Summary]])), '')
    assert.equal(renderCard('reply', new Map([['reply', { ...Summary, fileCount: 0 }]])), '')

    const failed = renderCard(
      'reply',
      new Map([['reply', { ...Summary, fileCount: 0, error: 'git diff 执行失败' }]])
    )
    assert.match(failed, /chat\.fileChangeSummaryUnavailable/u)
    assert.doesNotMatch(failed, /chat\.fileChangeSummaryFilesChanged/u)
  })
})
