import assert from 'node:assert/strict'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import type { ConversationCardContent } from '@velaros-ai/ui/conversation'

import { WorkbenchLocalizationProvider } from '../src/renderer/src/i18n/WorkbenchLocalizationProvider'
import { standaloneWorkbenchConversationRenderSlots } from '../src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots'

function renderCardContent(content: ConversationCardContent): string {
  const Probe = (): ReactElement | null =>
    standaloneWorkbenchConversationRenderSlots.conversationCardContent(content)
  return renderToStaticMarkup(
    createElement(
      WorkbenchLocalizationProvider,
      {
        value: {
          locale: 'zh-CN',
          setLocale: async () => undefined,
          t: (key) => key,
        },
      },
      createElement(Probe)
    )
  )
}

void describe('Workbench goal card', () => {
  void test('shows the goal with its pause and remove actions above the composer', () => {
    const markup = renderCardContent({
      kind: 'goal-lifecycle',
      model: {
        id: 'active-goal',
        objective: '把导出按钮改成下拉菜单',
        status: 'active',
        tone: 'active',
        primaryAction: 'pause',
        actions: ['pause', 'remove'],
        blockedAuditTurns: 0,
        updatedAt: 1,
      },
      busy: false,
      onAction: async () => true,
      onContinue: () => undefined,
    })

    assert.match(markup, /data-goal-status="active"/u)
    assert.match(markup, /chat\.goalDockTitle/u)
    assert.match(markup, /把导出按钮改成下拉菜单/u)
    assert.match(markup, /chat\.goalDockActionPause/u)
    assert.match(markup, /chat\.goalDockActionRemove/u)
    assert.doesNotMatch(markup, /chat\.goalDockActionContinue/u)
  })

  void test('leaves Desktop-only conversation cards out', () => {
    assert.equal(
      renderCardContent({ kind: 'project-auto-approval', notice: {} as never }),
      ''
    )
  })
})
