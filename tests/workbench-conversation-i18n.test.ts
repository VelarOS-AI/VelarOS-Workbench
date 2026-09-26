import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { canonicalConversationMessageKeys } from '@velaros-ai/ui/conversation'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'

void describe('Workbench conversation localization contract', () => {
  void test('resolves the shared typed manifest in both locales', () => {
    // UI 0.2.54 的共享会话文案清单有 345 个键；远少于此说明没读到完整清单。
    assert.ok(
      canonicalConversationMessageKeys.length > 300,
      'shared conversation manifest unexpectedly found too few keys',
    )

    for (const locale of ['zh-CN', 'en-US'] as const) {
      for (const key of canonicalConversationMessageKeys) {
        assert.notEqual(
          translateWorkbenchAppMessage(locale, key),
          key,
          `${locale} is missing ${key}`,
        )
      }
    }
  })

  void test('layers deliberate Workbench wording over the shared catalog', () => {
    assert.equal(translateWorkbenchAppMessage('en-US', 'chat.placeholder'), 'Ask Workbench…')
    assert.equal(translateWorkbenchAppMessage('zh-CN', 'status.completed'), '已完成')
    assert.equal(
      translateWorkbenchAppMessage('zh-CN', 'chat.goalDockContinueGuidance'),
      '基于当前实际状态继续推进原目标；保留已完成的工作，先确认未完成事项与未执行输入，再继续。',
    )
  })

  void test('localizes elapsed run time instead of rendering the translation key', () => {
    assert.equal(
      translateWorkbenchAppMessage('zh-CN', 'status.elapsedSeconds', {
        seconds: 7,
      }),
      '7秒',
    )
    assert.equal(
      translateWorkbenchAppMessage('en-US', 'status.elapsedSeconds', {
        seconds: 7,
      }),
      '7s',
    )
  })
})
