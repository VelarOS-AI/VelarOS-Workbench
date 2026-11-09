import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { type BrowserElementSelection } from '@velaros-ai/capabilities/browser/contracts'

import {
  buildBrowserElementDisplayFallback,
  formatBrowserElementSelectionsForPrompt,
} from '../src/renderer/src/runtime/workbenchBrowserElementContext'

function selection(overrides: Partial<BrowserElementSelection> = {}): BrowserElementSelection {
  return {
    id: 'element-1',
    url: 'https://example.test/login',
    title: 'Login',
    label: '登录按钮',
    tagName: 'button',
    role: 'button',
    text: 'Sign in',
    selector: '#submit',
    attributes: { id: 'submit', class: 'ignored', 'data-testid': 'login-submit' },
    rect: { x: 10, y: 20, width: 80, height: 32, centerX: 50, centerY: 36 },
    viewportWidth: 1280,
    viewportHeight: 800,
    target: null,
    capturedAt: 1,
    ...overrides,
  } as BrowserElementSelection
}

void describe('Workbench browser element context', () => {
  void test('formats picked elements and their interaction chain for the model like Desktop', () => {
    const context = formatBrowserElementSelectionsForPrompt([
      selection({
        interactionSteps: [
          { ...selection({ label: '用户名输入框', tagName: 'input' }), action: 'select', sequence: 1 },
          { ...selection(), action: 'click', sequence: 2 },
        ],
      }),
    ])

    assert.match(context, /^用户在当前浏览器页面手动选择了元素/u)
    assert.match(context, /1\. current=登录按钮\n {3}tag=button\n {3}role=button\n {3}selector=#submit/u)
    // 只摘要可定位的属性，样式类名之类的噪声不进上下文。
    assert.match(context, /attrs=id="submit" data-testid="login-submit"/u)
    assert.doesNotMatch(context, /class=/u)
    assert.match(context, /interaction_chain:\n {3} {3}1\. action=select\(pointer only\)/u)
    assert.match(context, /2\. action=click\(real page action\)/u)
    assert.equal(formatBrowserElementSelectionsForPrompt([]), '')
  })

  void test('labels a message that only carries picked elements', () => {
    // 怎么说、用什么隔开按界面语言给。
    const chinese = { separator: '、', describe: (elements: string) => `已选择页面元素：${elements}` }
    const english = { separator: ', ', describe: (elements: string) => `Selected page elements: ${elements}` }
    const picked = [selection(), selection({ id: 'element-2', label: '搜索框' })]
    assert.equal(buildBrowserElementDisplayFallback(picked, chinese), '已选择页面元素：登录按钮、搜索框')
    assert.equal(buildBrowserElementDisplayFallback(picked, english), 'Selected page elements: 登录按钮, 搜索框')
    assert.equal(buildBrowserElementDisplayFallback([], chinese), '')
  })
})
