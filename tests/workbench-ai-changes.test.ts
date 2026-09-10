import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  buildWorkbenchAiChangeDiffView,
  buildWorkbenchAiChangeTree,
  listWorkbenchAiChangeRounds,
  listWorkbenchAiChangeTreeFiles,
  type WorkbenchAiChangeTreeNode,
} from '../src/renderer/src/models/chat/workbenchAiChangeRounds'
import type { ChatMessage } from '../src/shared/contracts'
import type { WorkbenchChatRunFileChange } from '../src/shared/workbenchGit'

function message(id: string, role: 'user' | 'assistant', text: string, timestamp: number): ChatMessage {
  return { id, role, timestamp, blocks: [{ type: 'text', text }] } as ChatMessage
}

function change(
  path: string,
  status: WorkbenchChatRunFileChange['status'] = 'modified',
  patch = ''
): WorkbenchChatRunFileChange {
  return { path, status, additions: 1, deletions: 0, binary: false, patch, patchOmitted: false }
}

function summarizeTree(nodes: readonly WorkbenchAiChangeTreeNode[]): unknown[] {
  return nodes.map((node) =>
    node.kind === 'directory' ? { [node.name]: summarizeTree(node.children) } : node.name
  )
}

void describe('Workbench AI changes model', () => {
  void test('lists every run that changed files, newest first, with its prompt and run number', () => {
    const summary = (recordId: string, capturedAt: number, fileCount: number, error: string | null = null) => ({
      recordId,
      capturedAt,
      fileCount,
      additions: fileCount * 2,
      deletions: fileCount,
      error,
    })
    const rounds = listWorkbenchAiChangeRounds([
      {
        id: 'session-a',
        title: '重构缓存',
        messages: [
          message('u1', 'user', '  把缓存改成\nLRU  ', 1),
          message('a1', 'assistant', '好的', 2),
          { ...message('n1', 'user', '已回溯到第 1 轮之前', 3), conversationKind: 'system-notice' } as ChatMessage,
          message('u2', 'user', '补测试', 4),
          message('a2', 'assistant', '补好了', 5),
          message('u3', 'user', '只回答，不改文件', 6),
          message('a3', 'assistant', '这是说明', 7),
        ],
        messageRunMarkers: [
          { messageId: 'a2', timestamp: 50, runChanges: summary('r2', 500, 3) },
          { messageId: 'a1', timestamp: 20, runChanges: summary('r1', 200, 1) },
          // 没改文件的一轮不进面板；采集失败的一轮要进，面板里说明读不出来。
          { messageId: 'a3', timestamp: 70, runChanges: summary('r3', 700, 0) },
        ],
      },
      {
        id: 'session-b',
        title: '另一个会话',
        messages: [message('b1', 'user', '修样式', 1), message('b2', 'assistant', '改了', 2)],
        messageRunMarkers: [{ messageId: 'b2', timestamp: 10, runChanges: summary('rb', 600, 0, 'git failed') }],
      },
    ])

    assert.deepEqual(
      rounds.map((round) => [round.key, round.runNumber, round.prompt, round.fileCount, round.error]),
      [
        ['session-b\0rb', 1, '修样式', 0, 'git failed'],
        ['session-a\0r2', 2, '补测试', 3, null],
        ['session-a\0r1', 1, '把缓存改成 LRU', 1, null],
      ]
    )
    assert.equal(rounds[1]?.sessionTitle, '重构缓存')
  })

  void test('builds a compact file tree: folders first, single-child chains merged', () => {
    const tree = buildWorkbenchAiChangeTree([
      change('src/components/ui/Button.tsx'),
      change('src/components/ui/Input.tsx', 'added'),
      change('src/app.ts'),
      change('README.md', 'deleted'),
      change('docs/guide/intro.md'),
    ])
    assert.deepEqual(summarizeTree(tree), [
      { 'docs/guide': ['intro.md'] },
      { src: [{ 'components/ui': ['Button.tsx', 'Input.tsx'] }, 'app.ts'] },
      'README.md',
    ])
    assert.deepEqual(listWorkbenchAiChangeTreeFiles(tree).map((file) => file.path), [
      'docs/guide/intro.md',
      'src/components/ui/Button.tsx',
      'src/components/ui/Input.tsx',
      'src/app.ts',
      'README.md',
    ])
  })

  void test('shows the whole file when both sides can be rebuilt, the bare patch otherwise', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2,3 +2,3 @@',
      ' two',
      '-three',
      '+THREE',
      ' four',
      '',
    ].join('\n')
    const modified = change('src/a.ts', 'modified', patch)
    const base = 'one\ntwo\nthree\nfour\nfive\n'

    const full = buildWorkbenchAiChangeDiffView(modified, base)
    assert.equal(full.kind, 'rows')
    assert.equal(full.kind === 'rows' && full.fullFile, true)
    assert.deepEqual(
      full.kind === 'rows' ? full.rows.map((row) => `${row.kind}:${row.text}`) : [],
      [
        'context:one',
        'context:two',
        'deletion:three',
        'addition:THREE',
        'context:four',
        'context:five',
      ]
    )

    // 起点快照读不到：只看补丁里的那几行。
    const patchOnly = buildWorkbenchAiChangeDiffView(modified, null)
    assert.equal(patchOnly.kind === 'rows' && patchOnly.fullFile, false)
    assert.deepEqual(
      patchOnly.kind === 'rows' ? patchOnly.rows.map((row) => [row.kind, row.oldLine, row.newLine]) : [],
      [
        ['context', 2, 2],
        ['deletion', 3, null],
        ['addition', null, 3],
        ['context', 4, 4],
      ]
    )

    // 新建文件的「前」就是空文件，不需要快照。
    const created = buildWorkbenchAiChangeDiffView(
      change(
        'src/new.ts',
        'added',
        ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+hello', '+world', ''].join('\n')
      ),
      null
    )
    assert.deepEqual(
      created.kind === 'rows' ? [created.fullFile, created.rows.map((row) => row.kind)] : [],
      [true, ['addition', 'addition']]
    )

    assert.deepEqual(buildWorkbenchAiChangeDiffView({ ...modified, binary: true, patch: '' }, null), {
      kind: 'binary',
    })
    assert.deepEqual(
      buildWorkbenchAiChangeDiffView({ ...modified, patchOmitted: true, patch: '' }, null),
      { kind: 'omitted' }
    )
    // 补丁和快照对不上（快照被别的内容顶替）：不硬拼，退回补丁本身。
    const mismatched = buildWorkbenchAiChangeDiffView(modified, 'totally\ndifferent\n')
    assert.equal(mismatched.kind === 'rows' && mismatched.fullFile, false)
  })
})
