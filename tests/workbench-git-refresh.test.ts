import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, test } from 'bun:test'

import { createWorkbenchGitWorkspaceChangeRefresh } from '../src/renderer/src/hooks/useWorkbenchGitState'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench Git state follows the repository with every Git panel closed', () => {
  void test('the editor change markers re-read HEAD on each repository change', async () => {
    // Git 界面全关着：工作区一有改动（包括 .git 里的提交、切分支），轻量快照照样按顶栏的节奏重拉……
    const calls: string[] = []
    const refresh = createWorkbenchGitWorkspaceChangeRefresh({
      refreshLineStats: async () => {
        calls.push('line-stats')
      },
      refreshSummary: async () => {
        calls.push('summary')
      },
      isGitSurfaceActive: () => false,
      lineStatsDelayMs: 5,
      treeDecorationDelayMs: 60_000,
    })
    refresh.schedule()
    for (let waited = 0; calls.length === 0; waited += 5) {
      assert.ok(waited < 2_000, 'the lightweight snapshot was never refreshed')
      await delay(5)
    }
    refresh.cancel()
    assert.deepEqual(calls, ['line-stats'])

    // ……编辑区拿这份快照的时刻当序号重读 HEAD 里的全文，改动标记跟着重算。
    assert.match(
      readSource('src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts'),
      /gitStateRevision: gitState\.lineStatsSnapshot\?\.repository\s*\?\s*gitState\.lineStatsSnapshot\.checkedAt\s*:\s*null/u
    )
    assert.match(
      readSource('src/renderer/src/components/editor/EditorPanel.tsx'),
      /useWorkbenchGitHeadContent\(\{[\s\S]*?revision: gitStateRevision,/u
    )
    assert.match(
      readSource('src/renderer/src/hooks/useWorkbenchGitHeadContent.ts'),
      /\}, \[hostRuntime, path, projectRoot, revision\]\)/u
    )
  })

  void test('the watcher reports the repository state files the refresh depends on', () => {
    // 提交、切分支、拉取改的是 .git 里的 HEAD、index、refs：监听照报，别的内部文件不报。
    const watcher = readSource('src/main/workspace/watch/WorkbenchFileWatcher.ts')
    for (const name of ['HEAD', 'index', 'packed-refs', 'refs'])
      assert.match(watcher, new RegExp(`segments\\[1\\] === '${name}'`, 'u'))
  })
})
