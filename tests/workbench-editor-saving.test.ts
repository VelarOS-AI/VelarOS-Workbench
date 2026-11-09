import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'

import { type WorkbenchReadFileResult } from '@shared/contracts/workbench'

import {
  appendWorkbenchEditorSavedSnapshot,
  mergeWorkbenchEditorSavedTab,
  resolveWorkbenchEditorSaveTab,
  summarizeWorkbenchEditorSaveResults,
  type WorkbenchEditorSaveResult,
} from '../src/renderer/src/models/editor/workbenchEditorSaving'
import { collectWorkbenchEditorUnsavedPaths } from '../src/renderer/src/models/editor/workbenchEditorTabClose'
import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'

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
    encoding: 'utf-8',
    eol: 'lf',
  }
}

function tab(file: WorkbenchReadFileResult, content = file.content): WorkbenchOpenEditorTab {
  return { path: file.path, file, content }
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

    // 排队时捕获的标签仍是旧快照：沿着写盘记录找到最后存下的那份。
    assert.equal(resolveWorkbenchEditorSaveTab(tab(opened), trail).file, secondSave)
    assert.equal(resolveWorkbenchEditorSaveTab(tab(firstSave), trail).file, secondSave)
    // 状态已经换成别的快照（重新读了磁盘）：记录接不上，按状态里的来。
    const reloaded = tab(snapshot('external', 9))
    assert.equal(resolveWorkbenchEditorSaveTab(reloaded, trail), reloaded)
  })

  void test('a late save preserves the newer format even when its queued write fails', async () => {
    const opened = snapshot('on disk', 1)
    const firstRequest = {
      ...tab(opened, 'edited'),
      textConversion: { encoding: 'utf-8', eol: 'crlf' } as const,
    }
    // 第一次正在存成 CRLF，用户又选回磁盘原来的 LF，此时转换字段是 undefined。
    const secondRequest = { ...firstRequest, textConversion: undefined }
    let currentTab: WorkbenchOpenEditorTab = secondRequest
    const firstWrite = Promise.withResolvers<WorkbenchReadFileResult>()
    const applied = firstWrite.promise.then((saved) => {
      currentTab = mergeWorkbenchEditorSavedTab(currentTab, firstRequest, saved)
      return saved
    })
    firstWrite.resolve({ ...snapshot('edited', 2), eol: 'crlf' })
    const firstSaved = await applied

    assert.equal(currentTab.file, firstSaved)
    assert.deepEqual(currentTab.textConversion, { encoding: 'utf-8', eol: 'lf' })
    assert.deepEqual(collectWorkbenchEditorUnsavedPaths([currentTab]), [opened.path])

    const queued = resolveWorkbenchEditorSaveTab(secondRequest, [{ base: opened, saved: firstSaved }])
    assert.equal(queued.file, firstSaved)
    assert.deepEqual(queued.textConversion, { encoding: 'utf-8', eol: 'lf' })
    const secondWrite = Promise.withResolvers<WorkbenchReadFileResult>()
    const secondApplied = secondWrite.promise.then((saved) => {
      currentTab = mergeWorkbenchEditorSavedTab(currentTab, queued, saved)
    })
    secondWrite.reject(new Error('disk is full'))
    await assert.rejects(secondApplied, /disk is full/u)
    assert.deepEqual(currentTab.textConversion, { encoding: 'utf-8', eol: 'lf' })
    assert.deepEqual(collectWorkbenchEditorUnsavedPaths([currentTab]), [opened.path])

    // 重试确实落盘之后，转换才被确认；正文不变也不再阻止关闭。
    currentTab = mergeWorkbenchEditorSavedTab(currentTab, queued, snapshot('edited', 3))
    assert.equal(currentTab.textConversion, undefined)
    assert.deepEqual(collectWorkbenchEditorUnsavedPaths([currentTab]), [])
  })

  void test('keeps only the latest few saved snapshots per file', () => {
    let trail = appendWorkbenchEditorSavedSnapshot([], {
      base: snapshot('0', 0),
      saved: snapshot('1', 1),
    })
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
      [
        'd.ts',
        { status: 'failed', error: new AppError('VALIDATION', '工作台暂不直接编辑符号链接。') },
      ],
    ])
    const summary = summarizeWorkbenchEditorSaveResults(results)

    assert.deepEqual(summary.savedPaths, ['a.ts'])
    assert.deepEqual(
      summary.conflicts.map((item) => item.path),
      ['c.ts']
    )
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
    assert.match(controller, /applySavedFile\(saved, tab, \{ silent: true \}\)/u)
    assert.match(
      controller,
      /mergeWorkbenchEditorSavedTab\(currentTab, requestedTab, saved\)/u
    )
    // 同一文件的写盘排队，后一次以前一次存下的快照为准。
    assert.match(controller, /runSerializedSave\(requestedTab\.path/u)
    assert.match(controller, /resolveWorkbenchEditorSaveTab\(requestedTab, trail\)/u)
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
