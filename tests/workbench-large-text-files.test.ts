import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import { readWorkbenchTextFile } from '../src/main/workspace/TextFile'
import { WorkbenchProjectFileSystem } from '../src/main/workspace/WorkbenchProjectFileSystem'
import {
  hasFileSnapshotChanged,
  resolveWorkbenchEditorRereadMaxChars,
  WORKBENCH_EDITOR_READ_MAX_CHARS,
} from '../src/renderer/src/models/editor/workbenchEditorTabs'

/**
 * 大文件：先看体积、只读截断视图需要的开头；编辑到上限以上、保存过的文件重读时不能被截断——否则会
 * 变成只读，或者报一次假的外部修改。
 */

async function withProject(run: (root: string, data: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-large-files-')))
  const data = await mkdtemp(join(tmpdir(), 'workbench-large-files-data-'))
  try {
    await run(root, data)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
}

void describe('Workbench large text files', () => {
  void test('reads only the head a truncated view needs', async () => {
    await withProject(async (root) => {
      // 结尾是一个认不出的字节：只读开头就不会碰到它，文件仍按 UTF-8 截断显示。
      const filePath = join(root, 'huge.log')
      await writeFile(filePath, Buffer.concat([Buffer.from('line\r\n'.repeat(200_000)), Buffer.from([0xff])]))
      const read = await readWorkbenchTextFile(filePath, 1_000)
      assert.equal(read.truncated, true)
      assert.equal(read.content.length, 1_000)
      assert.equal(read.encoding, 'utf-8')
      assert.equal(read.eol, 'crlf')
      assert.equal(read.textIssue, undefined)
      assert.equal(read.size, (await stat(filePath)).size)
      assert.equal(read.totalLines, 201)

      // 切口落在多字节字符中间时按流式解码略过，不出替换字符。
      const chinesePath = join(root, 'chinese.txt')
      await writeFile(chinesePath, '中'.repeat(10_000))
      const chinese = await readWorkbenchTextFile(chinesePath, 1_001)
      assert.equal(chinese.content, '中'.repeat(1_001))
      assert.equal(chinese.textIssue, undefined)
    })
  })

  void test('a file saved past the open limit stays editable and unchanged on the next reread', async () => {
    await withProject(async (root, data) => {
      const filePath = join(root, 'grown.ts')
      const original = `${'x'.repeat(99)}\n`.repeat(2_900)
      await writeFile(filePath, original)
      const fileSystem = new WorkbenchProjectFileSystem()
      const opened = await fileSystem.readTextFile({
        projectRoot: root,
        path: 'grown.ts',
        maxChars: WORKBENCH_EDITOR_READ_MAX_CHARS,
      })
      assert.equal(opened.truncated, false)

      const before = await stat(filePath)
      const saved = await createWorkbenchAppParts(data).files.saveFile({
        projectRoot: root,
        path: 'grown.ts',
        content: `${original}${'y'.repeat(20_000)}\n`,
        encoding: opened.encoding,
        eol: opened.eol,
        expectedModifiedAt: before.mtimeMs,
        expectedSize: before.size,
      })
      assert.equal(saved.truncated, false)
      assert.ok(saved.content.length > WORKBENCH_EDITOR_READ_MAX_CHARS)

      // 按打开时的上限重读是截断的，会被当成外部修改；按标签握着的正文长度重读则一模一样。
      const atOpenLimit = await fileSystem.readTextFile({
        projectRoot: root,
        path: 'grown.ts',
        maxChars: WORKBENCH_EDITOR_READ_MAX_CHARS,
      })
      assert.equal(atOpenLimit.truncated, true)
      const reread = await fileSystem.readTextFile({
        projectRoot: root,
        path: 'grown.ts',
        maxChars: resolveWorkbenchEditorRereadMaxChars(saved),
      })
      assert.equal(reread.truncated, false)
      assert.equal(hasFileSnapshotChanged(saved, reread), false)
    })
  })

  void test('rereads keep the open limit for truncated files and images', () => {
    assert.equal(
      resolveWorkbenchEditorRereadMaxChars({ content: 'x'.repeat(10), truncated: false }),
      WORKBENCH_EDITOR_READ_MAX_CHARS
    )
    assert.equal(
      resolveWorkbenchEditorRereadMaxChars({ content: 'x'.repeat(400_000), truncated: true }),
      WORKBENCH_EDITOR_READ_MAX_CHARS
    )
    assert.equal(
      resolveWorkbenchEditorRereadMaxChars({ content: 'x'.repeat(400_000), truncated: false }),
      400_000
    )
    assert.equal(resolveWorkbenchEditorRereadMaxChars(undefined), WORKBENCH_EDITOR_READ_MAX_CHARS)
  })
})
