import assert from 'node:assert/strict'
import type { FSWatcher } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import {
  isWorkbenchSaveTemporaryName,
  writeFileAtomically,
  writeFileAtomicallySync,
} from '../src/main/workspace/AtomicFileWrite'
import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import { WorkbenchFileWatcher } from '../src/main/workspace/watch/WorkbenchFileWatcher'

import { refuseTrash } from './helpers/fakeTrash'

/**
 * 编辑器保存是原子的：同目录写临时文件、刷盘、rename 盖过目标，权限位不变；硬链接与别人的文件退回
 * 原地写，只读文件照旧拒绝；失败时不留临时文件。
 */

async function withDirectory(run: (root: string, data: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-atomic-save-')))
  const data = await mkdtemp(join(tmpdir(), 'workbench-atomic-save-data-'))
  try {
    await run(root, data)
  } finally {
    await chmod(root, 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
}

const isRoot = process.getuid?.() === 0

void describe('Workbench atomic save', () => {
  void test('replaces the file through a temporary sibling and keeps its permission bits', async () => {
    await withDirectory(async (root, data) => {
      const filePath = join(root, 'script.sh')
      await writeFile(filePath, 'echo old\n')
      await chmod(filePath, 0o750)
      const before = await stat(filePath)

      const saved = await createWorkbenchAppParts(data, { moveToTrash: refuseTrash }).files.saveFile({
        projectRoot: root,
        path: 'script.sh',
        content: 'echo new\n',
        expectedModifiedAt: before.mtimeMs,
        expectedSize: before.size,
      })
      const after = await stat(filePath)
      assert.equal(await readFile(filePath, 'utf8'), 'echo new\n')
      assert.notEqual(after.ino, before.ino, 'the new content arrives by rename, not in place')
      assert.equal(after.mode & 0o777, before.mode & 0o777)
      assert.equal(saved.modifiedAt, after.mtimeMs)
      assert.equal(saved.size, after.size)
      assert.deepEqual(await readdir(root), ['script.sh'])

      createWorkbenchAppParts(data, { moveToTrash: refuseTrash }).files.saveFileSync({
        projectRoot: root,
        path: 'script.sh',
        content: 'echo sync\n',
        expectedModifiedAt: after.mtimeMs,
        expectedSize: after.size,
      })
      assert.equal(await readFile(filePath, 'utf8'), 'echo sync\n')
      assert.equal((await stat(filePath)).mode & 0o777, before.mode & 0o777)
      assert.deepEqual(await readdir(root), ['script.sh'])
    })
  })

  void test('writes hard-linked files in place so every link sees the new content', async () => {
    await withDirectory(async (root) => {
      const filePath = join(root, 'shared.txt')
      const linkPath = join(root, 'alias.txt')
      await writeFile(filePath, 'before\n')
      await link(filePath, linkPath)
      const before = await stat(filePath)

      await writeFileAtomically(filePath, Buffer.from('after\n'), before)
      assert.equal(await readFile(linkPath, 'utf8'), 'after\n')
      assert.equal((await stat(filePath)).ino, before.ino)

      writeFileAtomicallySync(filePath, Buffer.from('again\n'), await stat(filePath))
      assert.equal(await readFile(linkPath, 'utf8'), 'again\n')
    })
  })

  void test('refuses read-only targets and leaves no temporary file behind on failure', async () => {
    await withDirectory(async (root) => {
      const readOnlyPath = join(root, 'locked.txt')
      await writeFile(readOnlyPath, 'locked\n')
      await chmod(readOnlyPath, 0o444)
      if (!isRoot) {
        await assert.rejects(
          () =>
            writeFileAtomically(readOnlyPath, Buffer.from('x'), {
              mode: 0o100444,
              nlink: 1,
              uid: process.getuid?.() ?? 0,
            }),
          /EACCES|EPERM/u
        )
        assert.equal(await readFile(readOnlyPath, 'utf8'), 'locked\n')
      }

      // 临时文件写好了、rename 到一个非空目录上必然失败：临时文件要被清掉。
      const directoryTarget = join(root, 'directory')
      await mkdir(directoryTarget)
      await writeFile(join(directoryTarget, 'child.txt'), 'child\n')
      const directoryStats = await stat(directoryTarget)
      const target = { mode: directoryStats.mode, nlink: 1, uid: directoryStats.uid }
      await assert.rejects(() => writeFileAtomically(directoryTarget, Buffer.from('x'), target))
      assert.throws(() => writeFileAtomicallySync(directoryTarget, Buffer.from('x'), target))
      assert.deepEqual((await readdir(root)).sort(), ['directory', 'locked.txt'])
      assert.deepEqual(await readdir(directoryTarget), ['child.txt'])
    })
  })

  void test.skipIf(process.platform === 'win32')('saves in a directory without write permission fall back to writing in place', async () => {
    if (isRoot) return
    await withDirectory(async (root) => {
      const filePath = join(root, 'config.txt')
      await writeFile(filePath, 'old\n')
      const before = await stat(filePath)
      await chmod(root, 0o555)
      await writeFileAtomically(filePath, Buffer.from('new\n'), before)
      await chmod(root, 0o755)
      assert.equal(await readFile(filePath, 'utf8'), 'new\n')
      assert.equal((await stat(filePath)).ino, before.ino)
    })
  })

  void test('the file watcher ignores the temporary sibling of a save', async () => {
    assert.equal(isWorkbenchSaveTemporaryName('.index.ts.1a2b3c4d.velaros-save'), true)
    assert.equal(isWorkbenchSaveTemporaryName('index.ts'), false)

    const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-atomic-save-watch-')))
    const watcher = new WorkbenchFileWatcher({ debounceMs: 5 })
    const port = watcher as unknown as {
      roots: Map<string, { watcher: FSWatcher }>
      receive(rootPath: string, filename: string | null): void
    }
    try {
      const received = Promise.withResolvers<readonly string[]>()
      await watcher.subscribe(root, (event) => received.resolve(event.paths))
      port.receive(root, 'src/.index.ts.1a2b3c4d.velaros-save')
      port.receive(root, 'src/index.ts')
      assert.deepEqual(await received.promise, ['src/index.ts'])
    } finally {
      watcher.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
