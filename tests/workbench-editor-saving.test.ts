import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { WorkbenchReadFileResult } from '@shared/contracts'

import {
  appendWorkbenchEditorSavedSnapshot,
  resolveWorkbenchEditorSaveBase,
  summarizeWorkbenchEditorSaveResults,
  type WorkbenchEditorSaveResult,
} from '../src/renderer/src/models/editor/workbenchEditorSaving'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function snapshot(content: string, modifiedAt: number): WorkbenchReadFileResult {
  return {
    projectRoot: '/project',
    path: 'src/app.ts',
    content,
    size: content.length,
    modifiedAt,
    totalLines: 1,
    truncated: false,
  }
}

void describe('editor saving', () => {
  void test('a save that starts before the previous one is committed uses the snapshot it wrote', () => {
    const opened = snapshot('a', 1)
    const firstSave = snapshot('ab', 2)
    const secondSave = snapshot('abc', 3)
    const trail = appendWorkbenchEditorSavedSnapshot(
      appendWorkbenchEditorSavedSnapshot([], { base: opened, saved: firstSave }),
      { base: firstSave, saved: secondSave }
    )

    // 标签里还是打开时的快照（状态没提交）：沿着写盘记录找到最后存下的那份。
    assert.equal(resolveWorkbenchEditorSaveBase(opened, trail), secondSave)
    assert.equal(resolveWorkbenchEditorSaveBase(firstSave, trail), secondSave)
    // 状态已经换成别的快照（重新读了磁盘）：记录接不上，按状态里的来。
    const reloaded = snapshot('external', 9)
    assert.equal(resolveWorkbenchEditorSaveBase(reloaded, trail), reloaded)
  })

  void test('keeps only the latest few saved snapshots per file', () => {
    let trail = appendWorkbenchEditorSavedSnapshot([], { base: snapshot('0', 0), saved: snapshot('1', 1) })
    for (let index = 1; index < 20; index += 1) {
      trail = appendWorkbenchEditorSavedSnapshot(trail, {
        base: trail.at(-1)!.saved,
        saved: snapshot(String(index + 1), index + 1),
      })
    }
    assert.equal(trail.length, 8)
    assert.equal(trail.at(-1)?.saved.content, '20')
  })

  void test('summarizes a batch into saved, conflicted and failed files', () => {
    const results = new Map<string, WorkbenchEditorSaveResult>([
      ['a.ts', { status: 'saved', file: snapshot('a', 1) }],
      ['b.ts', { status: 'skipped' }],
      ['c.ts', { status: 'conflict', change: { status: 'modified', detectedAt: 1 } }],
      ['d.ts', { status: 'failed', error: new AppError('VALIDATION', '工作台暂不直接编辑符号链接。') }],
    ])
    const summary = summarizeWorkbenchEditorSaveResults(results)

    assert.deepEqual(summary.savedPaths, ['a.ts'])
    assert.deepEqual(summary.conflicts.map((item) => item.path), ['c.ts'])
    assert.deepEqual(
      summary.failures.map((item) => [item.path, item.error.message]),
      [['d.ts', '工作台暂不直接编辑符号链接。']]
    )
  })

  void test('Save All writes each file through the guarded save path', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const saveAll = controller.slice(
      controller.indexOf('const saveAllOpenFiles'),
      controller.indexOf('return {', controller.indexOf('const saveAllOpenFiles'))
    )

    // 每个文件存好就落状态，并且只在正文还是保存那一刻的内容时才换成磁盘版本。
    assert.match(saveAll, /saveEditorTabs\(dirtyTabs\)/u)
    assert.doesNotMatch(saveAll, /content: saved\.content|setEditorContent\(/u)
    assert.match(controller, /applySavedFile\(saved, tab\.content, \{ silent: true \}\)/u)
    assert.match(
      controller,
      /content: currentTab\.content === savedContent \? saved\.content : currentTab\.content/u
    )
    // 同一文件的写盘排队，后一次以前一次存下的快照为准。
    assert.match(controller, /runSerializedSave\(requestedTab\.path/u)
    assert.match(controller, /resolveWorkbenchEditorSaveBase\(requestedTab\.file, trail\)/u)
  })

  void test('typing only replaces the tab text, never its disk snapshot', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const typing = controller.slice(
      controller.indexOf('const updateEditorContent'),
      controller.indexOf('const applyLanguageServiceFileChanges')
    )

    assert.match(typing, /updateOpenTabContent\(file, content\)/u)
    assert.doesNotMatch(typing, /rememberOpenFile/u)
    // 选过的格式转换跟着正文走；上次保存被拒的说明一改就作废。
    assert.match(controller, /\{ \.\.\.currentTab, content, unencodableSaveError: undefined \}/u)
  })
})
