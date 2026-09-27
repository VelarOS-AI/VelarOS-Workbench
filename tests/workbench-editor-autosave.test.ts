import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import type { WorkbenchReadFileResult } from '@shared/contracts'

import {
  buildWorkbenchEditorAutosaveNoticeKey,
  clearWorkbenchEditorAutosaveFailure,
  isWorkbenchEditorTabAutosavable,
  pruneWorkbenchEditorAutosaveFailures,
  recordWorkbenchEditorAutosaveFailure,
  resolveNextWorkbenchEditorAutosaveAt,
  resolveWorkbenchEditorAutosaveRetryDelayMs,
  selectDueWorkbenchEditorAutosaveTabs,
  WORKBENCH_EDITOR_AUTOSAVE_DELAY_MS,
  type WorkbenchEditorAutosaveFailures,
} from '../src/renderer/src/models/editor/workbenchEditorAutosave'
import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function tab(
  path: string,
  content: string,
  overrides: Partial<WorkbenchReadFileResult> & Pick<WorkbenchOpenEditorTab, 'externalChange'> = {}
): WorkbenchOpenEditorTab {
  const { externalChange, ...fileOverrides } = overrides
  return {
    path,
    content,
    externalChange,
    file: {
      projectRoot: '/project',
      path,
      content: 'on disk',
      size: 7,
      modifiedAt: 1,
      totalLines: 1,
      truncated: false,
      ...fileOverrides,
    },
  }
}

void describe('editor autosave', () => {
  void test('a file that cannot be saved does not hold back the other tabs', () => {
    const link = tab('link.ts', 'edited')
    const other = tab('other.ts', 'edited')
    const now = 10_000
    const failures = recordWorkbenchEditorAutosaveFailure(
      new Map(),
      link.path,
      '工作台暂不直接编辑符号链接。',
      now
    )

    // 失败的文件在退避期内不重试，其它改过的标签照常到点就存。
    assert.deepEqual(
      selectDueWorkbenchEditorAutosaveTabs([link, other], failures, now + 1000).map((item) => item.path),
      ['other.ts']
    )
    // 退避期过了，失败的文件再试一次。
    assert.deepEqual(
      selectDueWorkbenchEditorAutosaveTabs([link, other], failures, now + 5000).map((item) => item.path),
      ['link.ts', 'other.ts']
    )
  })

  void test('backs off per file and resets once the file is saved', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map(resolveWorkbenchEditorAutosaveRetryDelayMs),
      [5000, 10_000, 20_000, 40_000, 60_000, 60_000]
    )

    let failures: WorkbenchEditorAutosaveFailures = new Map()
    failures = recordWorkbenchEditorAutosaveFailure(failures, 'a.ts', 'EACCES', 0)
    failures = recordWorkbenchEditorAutosaveFailure(failures, 'a.ts', 'EACCES', 5000)
    assert.deepEqual(failures.get('a.ts'), { message: 'EACCES', attempts: 2, retryAt: 15_000 })

    failures = clearWorkbenchEditorAutosaveFailure(failures, 'a.ts')
    assert.equal(failures.has('a.ts'), false)
  })

  void test('schedules the next wake-up after the typing pause or the backoff, whichever is later', () => {
    const now = 1000
    const failing = tab('failing.ts', 'edited')
    const failures = recordWorkbenchEditorAutosaveFailure(new Map(), failing.path, 'EPERM', now)

    assert.equal(
      resolveNextWorkbenchEditorAutosaveAt([failing], failures, now),
      now + resolveWorkbenchEditorAutosaveRetryDelayMs(1)
    )
    assert.equal(
      resolveNextWorkbenchEditorAutosaveAt([failing, tab('fresh.ts', 'edited')], failures, now),
      now + WORKBENCH_EDITOR_AUTOSAVE_DELAY_MS
    )
    assert.equal(resolveNextWorkbenchEditorAutosaveAt([tab('clean.ts', 'on disk')], failures, now), null)
  })

  void test('only complete, modified tabs without a pending external change are autosaved', () => {
    assert.equal(isWorkbenchEditorTabAutosavable(tab('a.ts', 'edited')), true)
    assert.equal(isWorkbenchEditorTabAutosavable(tab('a.ts', 'on disk')), false)
    assert.equal(isWorkbenchEditorTabAutosavable(tab('a.ts', 'edited', { truncated: true })), false)
    assert.equal(
      isWorkbenchEditorTabAutosavable(
        tab('a.ts', 'edited', { externalChange: { status: 'modified', detectedAt: 1 } })
      ),
      false
    )
    // 上次因为文件编码写不出里面的字符被拒：改之前不再自动保存。
    assert.equal(
      isWorkbenchEditorTabAutosavable({ ...tab('a.ts', 'edited'), unencodableSaveError: 'GBK' }),
      false
    )
    // 磁盘字节写不回原样的文件，选了转换才归自动保存管；只选了转换、正文没改也算要存。
    const mixedEol = tab('a.ts', 'on disk', { textIssue: 'mixed-eol' })
    assert.equal(isWorkbenchEditorTabAutosavable(mixedEol), false)
    assert.equal(
      isWorkbenchEditorTabAutosavable({ ...mixedEol, textConversion: { encoding: 'utf-8', eol: 'lf' } }),
      true
    )
  })

  void test('drops failure marks for tabs that were saved, reverted or closed', () => {
    let failures: WorkbenchEditorAutosaveFailures = new Map()
    for (const path of ['saved.ts', 'closed.ts', 'still-failing.ts']) {
      failures = recordWorkbenchEditorAutosaveFailure(failures, path, 'EACCES', 0)
    }
    const pruned = pruneWorkbenchEditorAutosaveFailures(
      failures,
      new Map([
        ['saved.ts', tab('saved.ts', 'on disk')],
        ['still-failing.ts', tab('still-failing.ts', 'edited')],
      ])
    )

    assert.deepEqual([...pruned.keys()], ['still-failing.ts'])
    // 没有要撤的记录时原样返回，不触发多余的重渲染。
    assert.equal(pruneWorkbenchEditorAutosaveFailures(pruned, new Map([['still-failing.ts', tab('still-failing.ts', 'x')]])), pruned)
  })

  void test('notifies once per file and reason', () => {
    assert.notEqual(
      buildWorkbenchEditorAutosaveNoticeKey('a.ts', 'EACCES'),
      buildWorkbenchEditorAutosaveNoticeKey('a.ts', 'ENOSPC')
    )
    assert.notEqual(
      buildWorkbenchEditorAutosaveNoticeKey('a.ts', 'EACCES'),
      buildWorkbenchEditorAutosaveNoticeKey('b.ts', 'EACCES')
    )
  })

  void test('the autosave hook saves every due tab, records failures and marks the tab', () => {
    const hook = readSource('src/renderer/src/hooks/useWorkbenchEditorAutosave.ts')
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')

    // 不再只盯着第一个脏标签：每个到点的标签各存各的，失败按文件退避并只提示一次。
    assert.doesNotMatch(hook, /\.find\(\s*\(tab\) => !tab\.file\.truncated/u)
    assert.match(hook, /selectDueWorkbenchEditorAutosaveTabs\(/u)
    assert.match(hook, /dueTabs\.map\(async \(tab\)/u)
    assert.match(hook, /recordWorkbenchEditorAutosaveFailure\(next, path, result\.error\.message, now\)/u)
    assert.match(hook, /notifiedFailureKeysRef\.current\.has\(noticeKey\)/u)
    assert.doesNotMatch(hook, /log\.debug/u)
    assert.match(controller, /workbench\.autosaveFailedTitle/u)
    assert.match(tabBar, /workbench\.autosaveFailedTooltip/u)
    assert.match(tabBar, /data-autosave-failed=\{!!autosaveFailure\}/u)
  })
})
