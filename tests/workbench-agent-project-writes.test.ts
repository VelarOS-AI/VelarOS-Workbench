import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  publishWorkbenchAgentProjectWrite,
  subscribeWorkbenchAgentProjectWrites,
} from '../src/renderer/src/runtime/workbenchAgentProjectWrites'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench agent project writes', () => {
  void test('delivers a write to the subscribers of that project root only', () => {
    const received: string[] = []
    const stopA = subscribeWorkbenchAgentProjectWrites('/work/a/', () => received.push('a'))
    const stopB = subscribeWorkbenchAgentProjectWrites('/work/b', () => received.push('b'))

    publishWorkbenchAgentProjectWrite('/work/a')
    publishWorkbenchAgentProjectWrite('/work/c')
    assert.deepEqual(received, ['a'])

    stopA()
    publishWorkbenchAgentProjectWrite('/work/a')
    publishWorkbenchAgentProjectWrite('/work/b')
    assert.deepEqual(received, ['a', 'b'])
    stopB()
  })

  void test('main reports every closed project or shell write window as a project-activity notice', () => {
    const session = readSource('src/main/conversation/WorkbenchConversationSession.ts')
    const runtime = readSource('src/main/conversation/WorkbenchConversationRuntime.ts')

    // 项目编辑与命令都过同一道效果闸：这两个模块的每段写操作时间窗都经 beginCommand 报给归属账本。
    assert.match(session, /const ProjectWritingModules: readonly string\[\] = \['velaros:project', 'velaros:shell'\]/u)
    assert.match(session, /onMetric: \(metric\) => windows\.record\(metric\)/u)
    assert.match(session, /this\.activity\??\.beginCommand\(\)/u)
    // 时间窗一关就推一条项目动静通知，带上这一轮的运行身份。
    assert.match(
      runtime,
      /beginCommand: \(\) => \{\n\s*const finish = activity\.beginCommand\(\)\n\s*return \(\) => \{\n\s*finish\(\)\n[\s\S]*?sink\.notice\(ConversationProjectActivityNotice, \{ runId \}\)/u
    )
  })

  void test('one project-activity notice feeds both the live AI-changes capture and the Git refresh', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const gitState = readSource('src/renderer/src/hooks/useWorkbenchGitState.ts')
    const editor = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const capture = readSource('src/renderer/src/runtime/standaloneWorkbenchRunChangeCapture.ts')

    assert.match(
      adapter,
      /if \(event\.kind === ConversationProjectActivityNotice\) \{\n(?:\s*\/\/[^\n]*\n)*\s*run\.runChangeCapture\?\.request\(\)\n\s*publishWorkbenchAgentProjectWrite\(run\.projectRoot\)\n\s*return\n/u
    )
    assert.match(
      gitState,
      /subscribeWorkbenchAgentProjectWrites\(workspaceRoot, workspaceChangeRefresh\.schedule\)/u
    )
    assert.match(editor, /subscribeWorkbenchAgentProjectWrites\(activeProjectRootPath, \(\) => \{/u)
    // 没有第二套识别器：会话面、Git 状态与实时采集都不再自己按工具名认执行事件。
    assert.doesNotMatch(adapter, /project:(?:edit|write|run)|tool-done|ProjectWriteTracker/u)
    assert.doesNotMatch(gitState, /onAgentExecution|changedFiles|tool-done/u)
    assert.doesNotMatch(capture, /tool-done|tool-start|worker-thread/u)
  })
})
