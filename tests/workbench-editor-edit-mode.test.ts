import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  canEditWorkbenchFileContent,
  isWorkbenchFileEditable,
  resolveWorkbenchEditorEditMode,
} from '../src/renderer/src/models/editor/workbenchEditorEditMode'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

const trackedFile = { gitIgnored: false, truncated: false }
const ignoredFile = { gitIgnored: true, truncated: false }

describe('editor read-only / edit mode', () => {
  test('ignored files open read-only, other files open editable', () => {
    assert.equal(resolveWorkbenchEditorEditMode(ignoredFile, null), 'read-only')
    assert.equal(resolveWorkbenchEditorEditMode(trackedFile, null), 'edit')
  })

  test('the mode the user picked wins in both directions', () => {
    assert.equal(resolveWorkbenchEditorEditMode(ignoredFile, 'edit'), 'edit')
    assert.equal(isWorkbenchFileEditable(ignoredFile, 'edit'), true)
    assert.equal(resolveWorkbenchEditorEditMode(trackedFile, 'read-only'), 'read-only')
    assert.equal(isWorkbenchFileEditable(trackedFile, 'read-only'), false)
  })

  test('files without their full text stay uneditable in any mode', () => {
    assert.equal(isWorkbenchFileEditable({ gitIgnored: false, truncated: true }, 'edit'), false)
    assert.equal(canEditWorkbenchFileContent({ truncated: false, imagePreview: { mediaType: 'image/png', data: new Uint8Array() } }), false)
  })

  test('read-only only blocks typing and refactors: saving keeps working, AI writes never pass through it', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    // 输入与跨文件改名看模式；保存只看文本是否完整——切到只读之前改下的内容照样能保存。
    assert.match(controller, /isWorkbenchFileEditable\(selectedFile, chosenEditModes\.get\(selectedFile\.path\)\)\)\s*return/u)
    assert.match(controller, /!isWorkbenchFileEditable\(tab\.file, chosenEditModes\.get\(tab\.path\)\)/u)
    assert.match(controller, /!canEditWorkbenchFileContent\(tab\.file\)\s*\|\| tab\.content === tab\.file\.content/u)
    assert.doesNotMatch(controller, /gitIgnored/u)

    // AI 改文件经 Platform 运行时的项目内核写盘（主进程 conversation/），不经过编辑器缓冲区；
    // 编辑器模式只在编辑器控制器里生效。
    const conversationFiles = readdirSync(path.resolve(process.cwd(), 'src/main/conversation'))
      .filter((name) => /\.tsx?$/u.test(name))
    assert.ok(conversationFiles.length > 0)
    for (const name of conversationFiles) {
      assert.doesNotMatch(readSource(`src/main/conversation/${name}`), /EditMode|readOnlyFile/u, name)
    }
  })
})
