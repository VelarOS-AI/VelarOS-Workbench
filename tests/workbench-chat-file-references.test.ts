import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  appendWorkbenchChatFileReferences,
  buildWorkbenchChatFileReferenceOptions,
  formatWorkbenchChatFileReferencesForPrompt,
  readWorkbenchChatFileReferencePath,
  workbenchChatFileReferenceId,
} from '../src/renderer/src/models/chat/workbenchChatFileReferences'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench chat file references', () => {
  void test('adding files keeps the first-come order and never repeats a file', () => {
    assert.deepEqual(
      appendWorkbenchChatFileReferences(['src/a.ts'], ['src/b.ts', 'src/a.ts', 'src/c.ts', 'src/b.ts', '']),
      ['src/a.ts', 'src/b.ts', 'src/c.ts']
    )
  })

  void test('chips show the file name and add directories only to tell same-named files apart', () => {
    assert.deepEqual(
      buildWorkbenchChatFileReferenceOptions([
        'packages/project/src/agent/index.ts',
        'packages/project/src/core/index.ts',
        'packages/project/src/agent/Project.tool.ts',
      ]).map((option) => option.label),
      ['agent/index.ts', 'core/index.ts', 'Project.tool.ts']
    )
    // 完整路径放在正文里：`@` 列表作说明，chip 悬停时也看得到。
    assert.deepEqual(buildWorkbenchChatFileReferenceOptions(['src/app.ts']), [
      { id: workbenchChatFileReferenceId('src/app.ts'), label: 'app.ts', body: 'src/app.ts' },
    ])
  })

  void test('option ids round-trip to the referenced path', () => {
    assert.equal(
      readWorkbenchChatFileReferencePath(workbenchChatFileReferenceId('src/a b/c.ts')),
      'src/a b/c.ts'
    )
    assert.equal(readWorkbenchChatFileReferencePath('comment-1'), null)
  })

  void test('the model gets path anchors only, never the file contents', () => {
    const context = formatWorkbenchChatFileReferencesForPrompt(['src/a.ts', 'src/b.ts'])

    assert.equal(
      context,
      'Files the user referenced in the Workbench (paths only; their contents are not included, read them yourself as needed):\n- src/a.ts\n- src/b.ts'
    )
    assert.equal(formatWorkbenchChatFileReferencesForPrompt([]), '')
  })

  void test('a sent message carries the anchors and clears the chips, guidance included', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    assert.match(
      adapter,
      /const fileReferenceContext = formatWorkbenchChatFileReferencesForPrompt\(referencedFilePaths\)/u
    )
    assert.match(adapter, /currentFileContext,\s*fileReferenceContext,\s*attachmentContext,/u)
    // 运行中补发走引导通道：路径锚点折进引导正文。
    assert.match(adapter, /return sendRunGuidance\(text, selections, referencedFilePaths\)/u)
    assert.match(adapter, /formatWorkbenchChatFileReferencesForPrompt\(referencedFilePaths\),\s*\]/u)
    // 宿主续跑（目标自动续跑）不带用户挂的文件，也不清掉它们。
    assert.match(adapter, /const referencedFilePaths = systemNotice \? \[\] : selectedFileReferencePaths/u)
    assert.match(adapter, /setBrowserSelections\(\[\]\)\s*setSelectedFileReferencePaths\(\[\]\)/u)
  })

  void test('a file already referenced does not also show as the current-file chip', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    assert.match(
      adapter,
      /workbenchCurrentFilePath:\s*includedCurrentFilePath && !selectedFileReferencePaths\.includes\(includedCurrentFilePath\)/u
    )
  })

  void test('the editor, its tabs and the file tree all offer Add to Chat', () => {
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    const tabs = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    const files = readSource('src/renderer/src/components/files/FilePanel.tsx')
    const adapter = readSource('src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts')

    assert.match(editor, /onClick=\{addCurrentFileToChat\}/u)
    assert.match(tabs, /onAddFileToChat\(tabContextMenu\.path\)/u)
    // 文件树：右键点在多选里时整组一起挂。
    assert.match(files, /chatFilePaths: resolveTreeChatFilePaths\(treeApiRef\.current, entry\)/u)
    assert.match(files, /onAddFilesToChat\?\.\(contextMenu\.chatFilePaths\)/u)
    // 多选能留住：选中项在当前选择里（⌘/Shift 多选时是最后点的那项）就不把选择收回成单选。
    const tree = readSource('src/renderer/src/components/files/FileTree.tsx')
    assert.match(tree, /const selectionAlreadyMatches = tree\.selectedIds\.has\(selectedPath\)/u)
    assert.equal(adapter.match(/onAddFilesToChat: model\.actions\.addWorkbenchFilesToChat/gu)?.length, 2)
  })
})
