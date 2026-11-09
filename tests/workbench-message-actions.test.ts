import assert from 'node:assert/strict'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import type { ConversationBlockHooks } from '@velaros-ai/ui/conversation'

import { WorkbenchLocalizationProvider } from '../src/renderer/src/i18n/WorkbenchLocalizationProvider'
import {
  formatWorkbenchChatPathForDisplay,
  resolveWorkbenchChatAbsolutePath,
  resolveWorkbenchChatWorkspacePath,
} from '../src/renderer/src/models/chat/workbenchChatWorkspacePath'
import { standaloneWorkbenchConversationBlockHooks } from '../src/renderer/src/runtime/conversation/standaloneWorkbenchConversationBlockHooks'

type MessageActionOptions = Parameters<ConversationBlockHooks['useMessageActionView']>[0]
type MessageActionView = ReturnType<ConversationBlockHooks['useMessageActionView']>

const Root = '/work/project'

function captureMessageActionView(options: MessageActionOptions): MessageActionView {
  let view: MessageActionView | null = null
  const Probe = (): ReactElement | null => {
    view = standaloneWorkbenchConversationBlockHooks.useMessageActionView(options)
    return null
  }
  renderToStaticMarkup(
    createElement(
      WorkbenchLocalizationProvider,
      { value: { locale: 'zh-CN', setLocale: async () => undefined, t: (key) => key } },
      createElement(Probe)
    )
  )
  assert.ok(view)
  return view
}

void describe('Workbench message actions', () => {
  void test('resolves and shortens answer paths against the project root', () => {
    assert.equal(resolveWorkbenchChatAbsolutePath('src/app.ts', Root), '/work/project/src/app.ts')
    assert.equal(resolveWorkbenchChatAbsolutePath('./src/app.ts', Root), '/work/project/src/app.ts')
    assert.equal(resolveWorkbenchChatAbsolutePath('/tmp/report.pdf', Root), '/tmp/report.pdf')
    assert.equal(resolveWorkbenchChatAbsolutePath('~/notes.md', Root), '~/notes.md')

    assert.equal(formatWorkbenchChatPathForDisplay('/work/project/src/app.ts', Root), 'src/app.ts')
    assert.equal(formatWorkbenchChatPathForDisplay('/work/project', Root), '/work/project')
    assert.equal(formatWorkbenchChatPathForDisplay('/work/projects/other.ts', Root), '/work/projects/other.ts')
    assert.equal(formatWorkbenchChatPathForDisplay('src/app.ts', Root), 'src/app.ts')

    assert.equal(resolveWorkbenchChatWorkspacePath('/work/project/src/app.ts', Root), 'src/app.ts')
    assert.equal(resolveWorkbenchChatWorkspacePath('/tmp/report.pdf', Root), null)
    assert.equal(resolveWorkbenchChatWorkspacePath('/tmp/report.pdf', '/'), 'tmp/report.pdf')
  })

  void test('lists the files a run opened or moved under the answer, with project-relative titles', () => {
    const view = captureMessageActionView({
      activeProjectRoot: Root,
      sessionId: 'session',
      projectRoots: [],
      message: {
        id: 'reply',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool-call',
            toolCallId: 'open-1',
            toolName: 'open_path',
            input: {},
            result: { path: '/work/project/docs/guide.md' },
          },
          {
            type: 'tool-call',
            toolCallId: 'move-1',
            toolName: 'move_file',
            input: {},
            result: { toPath: '/tmp/archive/old.md' },
          },
        ],
      } as never,
    })

    assert.equal(view.hasActionItems, true)
    // 项目里的文件显示相对路径，项目外的原样；每一行都能打开、也能在访达中显示。
    assert.deepEqual(
      view.actionRows.map((row) => row.displayTitle).sort(),
      ['/tmp/archive/old.md', 'docs/guide.md']
    )
    assert.ok(view.actionRows.every((row) => !!row.onClick && !!row.onReveal))
    assert.equal(view.formatPathForDisplay('/work/project/src/app.ts'), 'src/app.ts')
  })

  void test('routes a path clicked in an answer to the editor and never to the system opener', async () => {
    const opened: string[] = []
    const view = captureMessageActionView({
      activeProjectRoot: Root,
      sessionId: 'session',
      projectRoots: [],
      message: { id: 'reply', role: 'assistant', timestamp: 1, blocks: [] } as never,
      onOpenProjectPath: async (path) => {
        opened.push(path)
        return false
      },
    })

    await view.openPathInLight('src/app.ts')
    assert.deepEqual(opened, ['/work/project/src/app.ts'])
  })
})
