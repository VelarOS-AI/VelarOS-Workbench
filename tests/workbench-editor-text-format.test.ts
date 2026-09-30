import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import type { WorkbenchReadFileResult } from '@shared/contracts'

import { readWorkbenchTextFile } from '../src/main/workspace/TextFile'
import { buildWorkbenchEditorSearchQuery } from '../src/renderer/src/models/editor/workbenchEditorFind'
import { DefaultWorkbenchEditorFindOptions } from '../src/renderer/src/models/editor/workbenchEditorFindState'
import {
  hasFileSnapshotChanged,
  isDirtyTab,
} from '../src/renderer/src/models/editor/workbenchEditorTabs'
import {
  buildWorkbenchStatusBarTextFormat,
  resolveWorkbenchTabTextFormat,
  resolveWorkbenchTextConversion,
  resolveWorkbenchTextFormatNotice,
} from '../src/renderer/src/models/editor/workbenchEditorTextFormat'
import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'
import {
  formatWorkbenchTextEncoding,
  formatWorkbenchTextEol,
} from '../src/shared/workbenchTextFormat'

/**
 * 编辑器的打开标签带着磁盘上的编码与换行符，每条保存路径都按它写回；用户明确选的转换
 * （转换为 UTF-8、换换行符）记在标签上，存下去之前算未保存。
 */

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function createFile(options: Partial<WorkbenchReadFileResult> = {}): WorkbenchReadFileResult {
  return {
    projectRoot: '/workspace/project',
    path: 'legacy.txt',
    content: '中文测试\n',
    encoding: 'gb18030',
    eol: 'crlf',
    size: 10,
    modifiedAt: 123,
    totalLines: 2,
    truncated: false,
    ...options,
  }
}

function createTab(
  file: WorkbenchReadFileResult,
  options: Partial<WorkbenchOpenEditorTab> = {}
): WorkbenchOpenEditorTab {
  return { path: file.path, file, content: file.content, ...options }
}

void describe('Workbench editor text format', () => {
  void test('a tab saves in the format read from disk unless the user chose a conversion', () => {
    const tab = createTab(createFile())
    assert.deepEqual(resolveWorkbenchTabTextFormat(tab), { encoding: 'gb18030', eol: 'crlf' })
    assert.equal(isDirtyTab(tab), false)

    const converted = createTab(tab.file, { textConversion: { encoding: 'utf-8', eol: 'crlf' } })
    assert.deepEqual(resolveWorkbenchTabTextFormat(converted), { encoding: 'utf-8', eol: 'crlf' })
    // 正文没变，但选了转换：存下去之前算未保存。
    assert.equal(isDirtyTab(converted), true)
  })

  void test('choosing the format already on disk is no conversion, unless the file cannot round-trip', () => {
    const file = createFile()
    assert.equal(resolveWorkbenchTextConversion(file, { encoding: 'gb18030', eol: 'crlf' }), undefined)
    assert.deepEqual(resolveWorkbenchTextConversion(file, { encoding: 'gb18030', eol: 'lf' }), {
      encoding: 'gb18030',
      eol: 'lf',
    })
    // 混用换行的文件选占多数的那种也是一次转换：存下去会统一所有换行。
    assert.deepEqual(
      resolveWorkbenchTextConversion(createFile({ textIssue: 'mixed-eol' }), {
        encoding: 'gb18030',
        eol: 'crlf',
      }),
      { encoding: 'gb18030', eol: 'crlf' }
    )
  })

  void test('a changed encoding or line ending on disk is an external change', () => {
    const file = createFile()
    assert.equal(hasFileSnapshotChanged(file, { ...file }), false)
    assert.equal(hasFileSnapshotChanged(file, { ...file, eol: 'lf' }), true)
    assert.equal(hasFileSnapshotChanged(file, { ...file, encoding: 'utf-8' }), true)
    assert.equal(hasFileSnapshotChanged(file, { ...file, textIssue: 'mixed-eol' }), true)
  })

  void test('the status bar shows the format and offers line endings only where they can be changed', () => {
    const tab = createTab(createFile())
    assert.deepEqual(buildWorkbenchStatusBarTextFormat(tab, 'edit'), {
      encoding: 'gb18030',
      eol: 'crlf',
      mixedEol: false,
      canChangeEol: true,
    })
    assert.equal(buildWorkbenchStatusBarTextFormat(tab, 'read-only')?.canChangeEol, false)
    assert.equal(
      buildWorkbenchStatusBarTextFormat(createTab(createFile({ truncated: true })), 'edit')
        ?.canChangeEol,
      false
    )
    // 编码写不回的文件换换行符也解决不了，只能转换为 UTF-8。
    assert.equal(
      buildWorkbenchStatusBarTextFormat(createTab(createFile({ textIssue: 'undecodable' })), 'edit')
        ?.canChangeEol,
      false
    )
    const mixed = buildWorkbenchStatusBarTextFormat(
      createTab(createFile({ textIssue: 'mixed-eol' })),
      'edit'
    )
    assert.equal(mixed?.mixedEol, true)
    assert.equal(mixed?.canChangeEol, true)
    // 选了转换之后显示的是要写成的格式。
    assert.deepEqual(
      buildWorkbenchStatusBarTextFormat(
        createTab(createFile(), { textConversion: { encoding: 'gb18030', eol: 'lf' } }),
        'edit'
      ),
      { encoding: 'gb18030', eol: 'lf', mixedEol: false, canChangeEol: true }
    )
    assert.equal(
      buildWorkbenchStatusBarTextFormat(
        createTab(createFile({ imagePreview: { mediaType: 'image/png', data: new Uint8Array() } })),
        'edit'
      ),
      null
    )
    assert.equal(formatWorkbenchTextEncoding('utf-16le-bom'), 'UTF-16 LE BOM')
    assert.equal(formatWorkbenchTextEncoding('gb18030'), 'GB18030')
    assert.equal(formatWorkbenchTextEol('crlf'), 'CRLF')
  })

  void test('the editor notice explains why a file is read-only and what the user can choose', () => {
    assert.equal(resolveWorkbenchTextFormatNotice(createTab(createFile())), null)
    assert.equal(
      resolveWorkbenchTextFormatNotice(createTab(createFile({ textIssue: 'irreversible' })))?.kind,
      'irreversible'
    )
    assert.deepEqual(
      resolveWorkbenchTextFormatNotice(
        createTab(createFile(), { unencodableSaveError: '第 1 行第 5 列的「😀」无法用 GB18030 表示。' })
      ),
      {
        kind: 'unencodable',
        encoding: 'gb18030',
        eol: 'crlf',
        message: '第 1 行第 5 列的「😀」无法用 GB18030 表示。',
      }
    )
    // 截断的文件转换不了；已经选了转换的等保存结果。
    assert.equal(
      resolveWorkbenchTextFormatNotice(
        createTab(createFile({ textIssue: 'mixed-eol', truncated: true }))
      ),
      null
    )
    assert.equal(
      resolveWorkbenchTextFormatNotice(
        createTab(createFile({ textIssue: 'mixed-eol' }), {
          textConversion: { encoding: 'gb18030', eol: 'crlf' },
        })
      ),
      null
    )
  })

  void test('every save path sends the tab format', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const autosave = readSource('src/renderer/src/hooks/useWorkbenchEditorAutosave.ts')
    const lightEditor = readSource('src/renderer/src/models/lightEditorModel.ts')
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')

    // 保存 / 全部保存 / 自动保存（saveTab）、恢复被删的文件、窗口关闭前的同步保存。
    assert.match(
      controller,
      /saveWorkbenchFile\(\{[\s\S]*?content: tab\.content,\n\s*\.\.\.resolveWorkbenchTabTextFormat\(tab\),/u
    )
    assert.match(
      controller,
      /restoreMissingWorkbenchFile\(\{[\s\S]*?content: tab\.content,\n\s*\.\.\.resolveWorkbenchTabTextFormat\(tab\),/u
    )
    assert.match(
      autosave,
      /saveWorkbenchFileSync\(\{[\s\S]*?content: tab\.content,\n\s*\.\.\.resolveWorkbenchTabTextFormat\(tab\),/u
    )
    // 手动保存当前文件时带上标签上选过的转换。
    assert.match(
      controller,
      /const saveSelectedFile = [\s\S]*?const tab = targetPath \? openTabsByPath\.get\(targetPath\) : undefined[\s\S]*?textConversion: tab\.textConversion,/u
    )
    // 从磁盘读来的预览标签带着格式保存；本地历史取回的正文先统一成 LF。
    assert.match(pageModel, /encoding: file\.encoding,\n\s*eol: file\.eol,\n\s*textIssue: file\.textIssue,/u)
    assert.match(lightEditor, /encoding: toOptional\(tab\.encoding\),\n\s*eol: toOptional\(tab\.eol\),/u)
    assert.match(editorPanel, /onEditorContentChange\(normalizeWorkbenchTextEol\(content\)\)/u)
  })

  void test('the status bar shows the format next to the cursor position', () => {
    const statusBar = readSource('src/renderer/src/components/chrome/StatusBar.tsx')
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    // 与 VS Code 同序：行列、缩进、编码、换行符。
    assert.match(
      statusBar,
      /\{t\('workbench\.cursorPosition', cursorPosition\)\}\n\s*<\/Text>\n\s*\{!!indentation && \(\n\s*<StatusBarIndentation[\s\S]*?\/>\n\s*\)\}\n\s*\{!!textFormat && <StatusBarTextFormat/u
    )
    assert.match(statusBar, /const StatusBarEolOptions: readonly WorkbenchTextEol\[\] = \['lf', 'crlf'\]/u)
    assert.match(
      presentation,
      /void workbench\.convertSelectedFileTextFormat\(\{\n\s*encoding: selectedTextFormat\.encoding,\n\s*eol,/u
    )
  })

  void test('find offsets in a CRLF file land where the editor document has the match', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-editor-find-'))
    try {
      const filePath = path.join(root, 'windows.txt')
      await writeFile(filePath, 'alpha\r\nbeta\r\ngamma target\r\n')
      const read = await readWorkbenchTextFile(filePath, 1_000)
      // 编辑缓冲从一开始就是 LF（CodeMirror 的文档也是），偏移不会随行号累积偏出 (line - 1) 个字符。
      assert.equal(read.content, 'alpha\nbeta\ngamma target\n')
      const state = EditorState.create({ doc: read.content })
      const match = buildWorkbenchEditorSearchQuery({
        ...DefaultWorkbenchEditorFindOptions,
        query: 'target',
        replace: '',
      })
        .getCursor(state)
        .next()
      assert.ok(!match.done)
      assert.equal(state.sliceDoc(match.value.from, match.value.to), 'target')
      assert.equal(match.value.from, 'alpha\nbeta\ngamma '.length)
      assert.equal(state.doc.lineAt(match.value.from).number, 3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
