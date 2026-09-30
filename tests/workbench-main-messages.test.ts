import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { setWorkbenchMainLocale } from '../src/main/i18n/workbenchMainLocale'
import { workbenchMainMessageTables, workbenchMainText } from '../src/main/i18n/workbenchMainMessages'

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!).sort()
}

/** 两种语言的说法不一样、用到的参数也不一样的（「a、b 等 7 个文件」对「a, b and 2 more」），调用方两个都给。 */
const DifferentParameters = new Set(['git.pathsMore'])

void describe('main-process message table', () => {
  void test('every message takes the same parameters in both languages', () => {
    const chinese = workbenchMainMessageTables['zh-CN']
    const english = workbenchMainMessageTables['en-US']
    assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort())
    for (const [key, template] of Object.entries(chinese)) {
      if (DifferentParameters.has(key)) continue
      assert.deepEqual(placeholders(english[key]!), placeholders(template), key)
    }
  })

  void test('the English table is English', () => {
    for (const [key, template] of Object.entries(workbenchMainMessageTables['en-US']))
      assert.doesNotMatch(template, /\p{Script=Han}/u, key)
  })

  void test('parameters are filled in, unknown ones are left visible', () => {
    setWorkbenchMainLocale('en-US')
    try {
      assert.equal(
        workbenchMainText('engines.exited', { engine: 'Codex', status: 'exit code 1' }),
        'Codex exited (exit code 1).'
      )
      assert.equal(
        workbenchMainText('account.serviceRequestFailed', { status: 503 }),
        'The VelarOS account service request failed (503).'
      )
      // 少给了参数：占位符原样留着，一眼能看出来，不悄悄变成 undefined。
      assert.equal(workbenchMainText('engines.exited', { engine: 'Codex' }), 'Codex exited ({status}).')
    } finally {
      setWorkbenchMainLocale('zh-CN')
    }
    assert.equal(workbenchMainText('conversation.runStopped'), '运行已停止。')
  })
})
