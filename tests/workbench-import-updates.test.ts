import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  composeWorkbenchImportUpdateRenames,
  createWorkbenchImportUpdater,
  selectWorkbenchImportUpdateRenames,
  type WorkbenchImportUpdateOutcome,
} from '../src/renderer/src/models/editor/workbenchImportUpdates'
import {
  buildWorkbenchLanguageServiceEditReport,
  type WorkbenchLanguageServiceEditOutcome,
} from '../src/renderer/src/models/editor/workbenchLanguageServiceEditReport'
import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'
import {
  type WorkbenchLanguageServiceFileEdit,
  type WorkbenchLanguageServiceFileRenameEditsRequest,
  type WorkbenchLanguageServiceFileRenameEditsResult,
  type WorkbenchReadFileResult,
} from '../src/shared/contracts/workbench'

const ProjectRoot = '/project'

function tab(path: string, content: string, diskContent = content): WorkbenchOpenEditorTab {
  const file: WorkbenchReadFileResult = {
    projectRoot: ProjectRoot,
    path,
    content: diskContent,
    encoding: 'utf-8',
    eol: 'lf',
    size: diskContent.length,
    modifiedAt: 1_000,
    totalLines: diskContent.split('\n').length,
    truncated: false,
  }
  return { path, content, file }
}

function edit(path: string, newText: string): WorkbenchLanguageServiceFileEdit {
  return {
    path,
    edits: [{ range: { startLine: 1, startColumn: 22, endLine: 1, endColumn: 28 }, newText }],
  }
}

type Respond = (result: Result<WorkbenchLanguageServiceFileRenameEditsResult>) => void

/** 一套假的端口：请求挂起等测试来答复，套上的改动、报告的结果都记下来。 */
function createHarness(options: { timeoutMs?: number } = {}) {
  const state = {
    projectRoot: ProjectRoot as Nullable<string>,
    tabs: [] as WorkbenchOpenEditorTab[],
    requests: [] as Array<{
      request: WorkbenchLanguageServiceFileRenameEditsRequest
      respond: Respond
    }>,
    applied: [] as string[][],
    reports: [] as WorkbenchImportUpdateOutcome[],
    applyOutcome: null as Nullable<WorkbenchLanguageServiceEditOutcome>,
  }
  const updater = createWorkbenchImportUpdater({
    getProjectRoot: () => state.projectRoot,
    getOpenTabs: () => state.tabs,
    requestEdits: (request) =>
      new Promise((resolve) => {
        state.requests.push({ request, respond: resolve })
      }),
    applyEdits: async (changes) => {
      state.applied.push(changes.map((change) => change.path))
      return state.applyOutcome ?? { changedFiles: changes.length, failures: [] }
    },
    report: (outcome) => {
      state.reports.push(outcome)
    },
    timeoutMs: options.timeoutMs,
  })
  /** 等到第 `count` 个请求发出来。 */
  const requestAt = async (count: number): Promise<(typeof state.requests)[number]> => {
    for (let turn = 0; turn < 50 && state.requests.length < count; turn += 1)
      await Promise.resolve()
    const pending = state.requests[count - 1]
    assert.ok(pending, `request #${count} was not sent`)
    return pending
  }
  const ok = (
    changes: WorkbenchLanguageServiceFileEdit[]
  ): Result<WorkbenchLanguageServiceFileRenameEditsResult> =>
    Result.ok({ projectRoot: ProjectRoot, changes })
  return { state, updater, requestAt, ok }
}

void describe('which tree moves update imports', () => {
  void test('JavaScript and TypeScript files and any folder; nothing else', () => {
    assert.deepEqual(
      selectWorkbenchImportUpdateRenames([
        { previousPath: 'src/a.ts', path: 'src/b.ts', type: 'file' },
        { previousPath: 'src/view.jsx', path: 'src/ui/view.jsx', type: 'file' },
        { previousPath: 'src/util', path: 'src/shared', type: 'directory' },
        { previousPath: 'README.md', path: 'docs/README.md', type: 'file' },
        { previousPath: 'src/data.json', path: 'src/values.json', type: 'file' },
        { previousPath: 'src/c.ts', path: 'src/c.txt', type: 'file' },
        { previousPath: 'src/same.ts', path: 'src/same.ts', type: 'file' },
      ]),
      [
        { previousPath: 'src/a.ts', path: 'src/b.ts' },
        { previousPath: 'src/view.jsx', path: 'src/ui/view.jsx' },
        { previousPath: 'src/util', path: 'src/shared' },
      ]
    )
  })

  void test('a second rename before the first was applied is asked from the original name', () => {
    assert.deepEqual(
      composeWorkbenchImportUpdateRenames(
        [{ previousPath: 'src/a.ts', path: 'src/b.ts' }],
        [{ previousPath: 'src/b.ts', path: 'src/c.ts' }]
      ),
      [
        { previousPath: 'src/a.ts', path: 'src/c.ts' },
        { previousPath: 'src/b.ts', path: 'src/c.ts' },
      ]
    )
    // 文件改了名，接着它所在的目录又挪了。
    assert.deepEqual(
      composeWorkbenchImportUpdateRenames(
        [{ previousPath: 'src/util/a.ts', path: 'src/util/b.ts' }],
        [{ previousPath: 'src/util', path: 'src/lib/util' }]
      ),
      [
        { previousPath: 'src/util/a.ts', path: 'src/lib/util/b.ts' },
        { previousPath: 'src/util', path: 'src/lib/util' },
      ]
    )
    // 改回原名：引用方写的本来就是它。
    assert.deepEqual(
      composeWorkbenchImportUpdateRenames(
        [{ previousPath: 'src/a.ts', path: 'src/b.ts' }],
        [{ previousPath: 'src/b.ts', path: 'src/a.ts' }]
      ),
      [{ previousPath: 'src/b.ts', path: 'src/a.ts' }]
    )
    // 不相干的两次改名各问各的；名字只是前缀相同的不算在目录里。
    assert.deepEqual(
      composeWorkbenchImportUpdateRenames(
        [{ previousPath: 'src/util.ts', path: 'src/tools.ts' }],
        [{ previousPath: 'src/tools', path: 'src/kit' }]
      ),
      [
        { previousPath: 'src/util.ts', path: 'src/tools.ts' },
        { previousPath: 'src/tools', path: 'src/kit' },
      ]
    )
  })
})

void describe('updating imports after a tree move', () => {
  void test('asks with the open buffers, applies open files first and reports once', async () => {
    const { state, updater, requestAt, ok } = createHarness()
    state.tabs = [
      tab(
        'src/main.ts',
        "import { add } from './math' // unsaved\n",
        "import { add } from './math'\n"
      ),
      tab('src/other.ts', 'export const other = 1\n'),
      tab('README.md', '# readme\n'),
    ]
    const done = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/math.ts', path: 'src/calc.ts', type: 'file' },
    ])

    const { request, respond } = await requestAt(1)
    assert.deepEqual(request, {
      projectRoot: ProjectRoot,
      renames: [{ previousPath: 'src/math.ts', path: 'src/calc.ts' }],
      openFiles: [
        { path: 'src/main.ts', content: "import { add } from './math' // unsaved\n" },
        { path: 'src/other.ts', content: 'export const other = 1\n' },
      ],
    })
    respond(
      ok([
        edit('src/closed.ts', './calc'),
        edit('src/main.ts', './calc'),
        { path: 'src/empty.ts', edits: [] },
      ])
    )
    await done

    assert.deepEqual(state.applied, [['src/main.ts', 'src/closed.ts']])
    assert.deepEqual(state.reports, [{ kind: 'applied', changedFiles: 2, failures: [] }])
  })

  void test('says nothing when no import needs to change, and never asks for other files', async () => {
    const { state, updater, requestAt, ok } = createHarness()
    await updater.entriesMoved(ProjectRoot, [
      { previousPath: 'notes.md', path: 'docs/notes.md', type: 'file' },
    ])
    assert.equal(state.requests.length, 0)

    const done = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'docs', path: 'manual', type: 'directory' },
    ])
    ;(await requestAt(1)).respond(ok([]))
    await done
    assert.deepEqual(state.reports, [])
  })

  void test('a tab that has not followed the move yet is sent under its new path', async () => {
    const { state, updater, requestAt, ok } = createHarness()
    // 标签的路径要等下一次渲染才换；被挪的文件自己也有相对 import 要改。
    state.tabs = [tab('src/util/math.ts', "import { base } from './base'\n")]
    const done = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/util', path: 'src/lib/util', type: 'directory' },
    ])

    const { request, respond } = await requestAt(1)
    assert.deepEqual(request.openFiles, [
      { path: 'src/lib/util/math.ts', content: "import { base } from './base'\n" },
    ])
    state.tabs = [tab('src/lib/util/math.ts', "import { base } from './base'\n")]
    respond(ok([edit('src/lib/util/math.ts', '../base')]))
    await done

    assert.equal(state.requests.length, 1)
    assert.deepEqual(state.applied, [['src/lib/util/math.ts']])
  })

  void test('recomputes when an importer was edited while the answer was on its way', async () => {
    const { state, updater, requestAt, ok } = createHarness()
    state.tabs = [tab('src/main.ts', "import { add } from './math'\n")]
    const done = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/math.ts', path: 'src/calc.ts', type: 'file' },
    ])

    const first = await requestAt(1)
    state.tabs = [
      tab(
        'src/main.ts',
        "// typed meanwhile\nimport { add } from './math'\n",
        "import { add } from './math'\n"
      ),
    ]
    first.respond(ok([edit('src/main.ts', './calc'), edit('src/closed.ts', './calc')]))

    const second = await requestAt(2)
    assert.equal(
      second.request.openFiles?.[0]?.content,
      "// typed meanwhile\nimport { add } from './math'\n"
    )
    assert.deepEqual(state.applied, [])
    second.respond(ok([edit('src/main.ts', './calc'), edit('src/closed.ts', './calc')]))
    await done

    assert.deepEqual(state.applied, [['src/main.ts', 'src/closed.ts']])
    assert.deepEqual(state.reports, [{ kind: 'applied', changedFiles: 2, failures: [] }])
  })

  void test('gives up on a file that keeps changing, and still updates the others', async () => {
    const { state, updater, requestAt, ok } = createHarness()
    state.tabs = [tab('src/main.ts', 'v0')]
    const done = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/math.ts', path: 'src/calc.ts', type: 'file' },
    ])

    for (const attempt of [1, 2, 3]) {
      const pending = await requestAt(attempt)
      state.tabs = [tab('src/main.ts', `v${attempt}`)]
      pending.respond(ok([edit('src/main.ts', './calc'), edit('src/closed.ts', './calc')]))
    }
    await done

    assert.equal(state.requests.length, 3)
    assert.deepEqual(state.applied, [['src/closed.ts']])
    assert.deepEqual(state.reports, [
      {
        kind: 'applied',
        changedFiles: 1,
        failures: [{ path: 'src/main.ts', reason: 'changed-in-editor' }],
      },
    ])
  })

  void test('a newer move replaces the unanswered one and asks for both together', async () => {
    const { state, updater, requestAt, ok } = createHarness()
    void updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/a.ts', path: 'src/b.ts', type: 'file' },
    ])
    const first = await requestAt(1)
    const done = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/b.ts', path: 'src/c.ts', type: 'file' },
    ])

    // 旧的一轮答复回来也不用了：照着已经不存在的 b 算的。
    first.respond(ok([edit('src/main.ts', './b')]))
    const second = await requestAt(2)
    assert.deepEqual(second.request.renames, [
      { previousPath: 'src/a.ts', path: 'src/c.ts' },
      { previousPath: 'src/b.ts', path: 'src/c.ts' },
    ])
    second.respond(ok([edit('src/main.ts', './c')]))
    await done

    assert.deepEqual(state.applied, [['src/main.ts']])
    assert.equal(state.reports.length, 1)

    // 这一轮做完了，后面的改名不再带着它。
    const later = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/x.ts', path: 'src/y.ts', type: 'file' },
    ])
    const third = await requestAt(3)
    assert.deepEqual(third.request.renames, [{ previousPath: 'src/x.ts', path: 'src/y.ts' }])
    third.respond(ok([]))
    await later
  })

  void test('reports when the language service fails or does not answer in time', async () => {
    const failing = createHarness()
    const failed = failing.updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/a.ts', path: 'src/b.ts', type: 'file' },
    ])
    ;(await failing.requestAt(1)).respond(
      Result.fail(new AppError('TIMEOUT', 'language service timed out'))
    )
    await failed
    assert.deepEqual(failing.state.reports, [
      { kind: 'failed', message: 'language service timed out' },
    ])
    assert.deepEqual(failing.state.applied, [])

    const silent = createHarness({ timeoutMs: 5 })
    await silent.updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/a.ts', path: 'src/b.ts', type: 'file' },
    ])
    assert.deepEqual(silent.state.reports, [{ kind: 'failed', message: undefined }])
    assert.deepEqual(silent.state.applied, [])

    // 失败的那一轮不留尾巴。
    const next = silent.updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/x.ts', path: 'src/y.ts', type: 'file' },
    ])
    const pending = await silent.requestAt(2)
    assert.deepEqual(pending.request.renames, [{ previousPath: 'src/x.ts', path: 'src/y.ts' }])
    pending.respond(silent.ok([]))
    await next
  })

  void test('drops the answer when another project was opened in the meantime', async () => {
    const { state, updater, requestAt, ok } = createHarness()
    const done = updater.entriesMoved(ProjectRoot, [
      { previousPath: 'src/a.ts', path: 'src/b.ts', type: 'file' },
    ])
    const pending = await requestAt(1)
    state.projectRoot = '/another'
    pending.respond(ok([edit('src/main.ts', './b')]))
    await done

    assert.deepEqual(state.applied, [])
    assert.deepEqual(state.reports, [])
  })
})

void describe('what the user is told after imports were updated', () => {
  const english = (key: string, params?: Record<string, string | number>): string =>
    translateWorkbenchAppMessage('en-US', key, params)

  void test('one line with the number of files, and the files that were left alone', () => {
    assert.deepEqual(
      buildWorkbenchLanguageServiceEditReport(
        { changedFiles: 3, failures: [] },
        { kind: 'import-update', translate: english }
      ),
      { tone: 'success', title: 'Imports updated (files changed: 3)', description: undefined }
    )
    assert.equal(
      buildWorkbenchLanguageServiceEditReport(
        { changedFiles: 0, failures: [] },
        { kind: 'import-update', translate: english }
      ),
      null
    )
    assert.deepEqual(
      buildWorkbenchLanguageServiceEditReport(
        {
          changedFiles: 1,
          failures: [
            { path: 'src/main.ts', reason: 'changed-in-editor' },
            { path: 'src/vendor.ts', reason: 'read-only' },
          ],
        },
        { kind: 'import-update', translate: english }
      ),
      {
        tone: 'warning',
        title: 'Imports updated (files changed: 1); some files were not changed',
        description: 'src/main.ts: the file was being edited; src/vendor.ts: the file is read-only',
      }
    )
  })
})
