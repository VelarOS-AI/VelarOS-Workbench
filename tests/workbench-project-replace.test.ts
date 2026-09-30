import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, mock, test } from 'bun:test'

import type { WorkbenchContentSearchWorkerOptions } from '../src/main/workspace/ContentSearchWorkerHost'
import type {
  WorkbenchReplaceContentFileRequest,
  WorkbenchReplaceContentRequest,
  WorkbenchReplaceContentResult,
} from '../src/shared/contracts'
import type { WorkbenchFsCallResult } from '../src/shared/workbenchFs'
import { WorkbenchFsChannels } from '../src/shared/workbenchFs'

import { refuseTrash } from './helpers/fakeTrash'
import { RunawayRegex, RunawayText, sourceSearchWorker } from './helpers/searchWorker'

/**
 * 项目搜索的替换（没在编辑器里开着的文件）：重新找匹配、经保存管线写回——编码、BOM 与换行符照磁盘上的来，
 * 搜索之后被改过的文件不动，替换前后都记进本地历史；跑不完的正则在 worker 里被停下，文件不动。
 */

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    on: () => undefined,
  },
}))

const { createWorkbenchAppParts } = await import('../src/main/workspace/Parts')
const { registerWorkbenchFsIpc } = await import('../src/main/workspace/WorkbenchFsIpc')

/** 「第一行\r\n中文测试\r\n」的 GBK 字节，CRLF 换行。 */
const GbkCrlf = Uint8Array.from([
  0xb5, 0xda, 0xd2, 0xbb, 0xd0, 0xd0, 0x0d, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0d, 0x0a,
])
/** 「第一行\r\n中文示例\r\n」的 GBK 字节。 */
const GbkCrlfReplaced = Uint8Array.from([
  0xb5, 0xda, 0xd2, 0xbb, 0xd0, 0xd0, 0x0d, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xbe, 0xc0, 0xfd, 0x0d, 0x0a,
])

type Parts = ReturnType<typeof createWorkbenchAppParts>

async function withProject(
  files: Record<string, string | Uint8Array>,
  run: (context: { root: string; parts: Parts }) => Promise<void>,
  searchWorker: WorkbenchContentSearchWorkerOptions = {}
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-project-replace-')))
  const data = await mkdtemp(join(tmpdir(), 'workbench-project-replace-data-'))
  try {
    for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content)
    const parts = createWorkbenchAppParts(data, {
      moveToTrash: refuseTrash,
      searchWorker: { ...sourceSearchWorker, ...searchWorker },
    })
    await run({ root, parts })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
}

async function snapshot(root: string, path: string): Promise<Pick<WorkbenchReplaceContentFileRequest, 'expectedModifiedAt' | 'expectedSize'>> {
  const fileStats = await stat(join(root, path))
  return { expectedModifiedAt: fileStats.mtimeMs, expectedSize: fileStats.size }
}

async function replace(
  parts: Parts,
  root: string,
  request: Omit<WorkbenchReplaceContentRequest, 'projectRoot' | 'files'> & {
    files: Array<Pick<WorkbenchReplaceContentFileRequest, 'path' | 'matches'>>
  }
): Promise<WorkbenchReplaceContentResult> {
  const files: WorkbenchReplaceContentFileRequest[] = []
  for (const file of request.files) files.push({ ...file, ...(await snapshot(root, file.path)) })
  return parts.replace.replaceContent({ ...request, projectRoot: root, files })
}

void describe('project replace in files that are not open', () => {
  void test('keeps GB18030 bytes and CRLF line endings, and UTF-8 BOM files keep their BOM', async () => {
    await withProject(
      {
        'gbk.txt': GbkCrlf,
        'bom.ts': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('let 测试 = 1\r\n', 'utf8')]),
      },
      async ({ root, parts }) => {
        const result = await replace(parts, root, {
          query: '测试',
          replacement: '示例',
          files: [{ path: 'gbk.txt' }, { path: 'bom.ts' }],
        })
        assert.deepEqual(result.files, [
          { path: 'gbk.txt', replacedCount: 1 },
          { path: 'bom.ts', replacedCount: 1 },
        ])
        assert.deepEqual(new Uint8Array(await readFile(join(root, 'gbk.txt'))), GbkCrlfReplaced)
        assert.deepEqual(
          await readFile(join(root, 'bom.ts')),
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('let 示例 = 1\r\n', 'utf8')])
        )
      }
    )
  })

  void test('regex replacements take capture groups; the chosen matches are the only ones replaced', async () => {
    await withProject(
      { 'a.ts': 'call(alpha, beta)\ncall(gamma, delta)\ncall(x, y)\n' },
      async ({ root, parts }) => {
        const swapped = await replace(parts, root, {
          query: 'call\\((\\w+), (\\w+)\\)',
          regex: true,
          replacement: 'call($2, $1)',
          files: [{ path: 'a.ts', matches: [{ line: 2, column: 1, endLine: 2, endColumn: 19 }] }],
        })
        assert.deepEqual(swapped.files, [{ path: 'a.ts', replacedCount: 1 }])
        assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'call(alpha, beta)\ncall(delta, gamma)\ncall(x, y)\n')

        const all = await replace(parts, root, {
          query: 'CALL',
          matchCase: false,
          wholeWord: true,
          replacement: 'invoke',
          files: [{ path: 'a.ts' }],
        })
        assert.deepEqual(all.files, [{ path: 'a.ts', replacedCount: 3 }])
        assert.equal(
          await readFile(join(root, 'a.ts'), 'utf8'),
          'invoke(alpha, beta)\ninvoke(delta, gamma)\ninvoke(x, y)\n'
        )
      }
    )
  })

  void test('records the text before and after the replacement in local history', async () => {
    await withProject({ 'notes.md': 'old text\n' }, async ({ root, parts }) => {
      await replace(parts, root, { query: 'old', replacement: 'new', files: [{ path: 'notes.md' }] })
      const history = parts.files.listLocalHistory({ projectRoot: root, path: 'notes.md' })
      const contents = history.entries.map(
        (entry) => parts.files.readLocalHistorySnapshot({ projectRoot: root, path: 'notes.md', id: entry.id }).content
      )
      assert.deepEqual(contents, ['new text\n', 'old text\n'])
    })
  })

  void test('leaves files alone that changed since the search or cannot be written back', async () => {
    await withProject(
      {
        'changed.ts': 'needle\n',
        'moved.ts': 'x needle\nneedle\n',
        'mixed.txt': 'needle\r\nline\nneedle\n',
        'gbk.txt': GbkCrlf,
        'fine.ts': 'needle\n',
      },
      async ({ root, parts }) => {
        const files: WorkbenchReplaceContentFileRequest[] = [
          { path: 'changed.ts', ...(await snapshot(root, 'changed.ts')) },
          {
            path: 'moved.ts',
            ...(await snapshot(root, 'moved.ts')),
            // 搜索时的位置：第一行第 1 列；现在那里没有匹配。
            matches: [{ line: 1, column: 1, endLine: 1, endColumn: 7 }],
          },
          { path: 'mixed.txt', ...(await snapshot(root, 'mixed.txt')) },
          { path: 'fine.ts', ...(await snapshot(root, 'fine.ts')) },
        ]
        await writeFile(join(root, 'changed.ts'), 'needle needle\n')

        const result = await parts.replace.replaceContent({
          projectRoot: root,
          query: 'needle',
          replacement: 'pin',
          files,
        })
        const byPath = new Map(result.files.map((file) => [file.path, file]))
        assert.equal(byPath.get('changed.ts')?.error?.code, 'CONFLICT')
        assert.equal(byPath.get('moved.ts')?.error?.code, 'CONFLICT')
        assert.equal(byPath.get('mixed.txt')?.error?.code, 'VALIDATION')
        assert.deepEqual(byPath.get('fine.ts'), { path: 'fine.ts', replacedCount: 1 })
        assert.equal(await readFile(join(root, 'changed.ts'), 'utf8'), 'needle needle\n')
        assert.equal(await readFile(join(root, 'moved.ts'), 'utf8'), 'x needle\nneedle\n')
        assert.equal(await readFile(join(root, 'mixed.txt'), 'utf8'), 'needle\r\nline\nneedle\n')

        // GB18030 写不出的字符：拒绝保存，文件原样。
        const unencodable = await replace(parts, root, {
          query: '测试',
          replacement: '😀',
          files: [{ path: 'gbk.txt' }],
        })
        assert.equal(unencodable.files[0]?.replacedCount, 0)
        assert.ok(unencodable.files[0]?.error)
        assert.deepEqual(new Uint8Array(await readFile(join(root, 'gbk.txt'))), GbkCrlf)
      }
    )
  })

  void test('a regex that runs away is stopped: that file and the ones after it are left alone', async () => {
    const quick = RunawayText.replace('\n', ';\n')
    await withProject(
      { 'a.ts': RunawayText, 'b.ts': quick },
      async ({ root, parts }) => {
        const result = await replace(parts, root, {
          query: RunawayRegex,
          regex: true,
          replacement: 'x',
          files: [{ path: 'a.ts' }, { path: 'b.ts' }],
        })
        // 在 a.ts 上回溯停不下来；b.ts 上本来很快，但同一个正则多半还会卡，不再试。
        assert.deepEqual(
          result.files.map((file) => [file.path, file.replacedCount, file.error?.code]),
          [
            ['a.ts', 0, 'TIMEOUT'],
            ['b.ts', 0, 'TIMEOUT'],
          ]
        )
        assert.match(result.files[0]?.error?.message ?? '', /a\.ts/u)
        assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), RunawayText)
        assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), quick)
      },
      { stallTimeoutMs: 250 }
    )
  })

  void test('the replace IPC reports the replaced files as the user’s writes and validates requests', async () => {
    await withProject({ 'a.ts': 'needle\n', 'b.ts': 'nothing\n' }, async ({ root, parts }) => {
      const writes: Array<{ workspaceRoot: string; paths: readonly string[] }> = []
      registerWorkbenchFsIpc({} as never, parts, {} as never, {
        recordUserWrites: (request) => writes.push(request),
      })
      const handler = ipcHandlers.get(WorkbenchFsChannels.replaceContent)!
      const envelope = (await handler(
        {},
        {
          projectRoot: root,
          query: 'needle',
          replacement: 'pin',
          files: [
            { path: 'a.ts', ...(await snapshot(root, 'a.ts')) },
            { path: 'b.ts', ...(await snapshot(root, 'b.ts')) },
          ],
        }
      )) as WorkbenchFsCallResult<WorkbenchReplaceContentResult>
      assert.ok(envelope.ok)
      assert.deepEqual(writes, [{ workspaceRoot: root, paths: ['a.ts'] }])

      for (const invalid of [
        { projectRoot: root, query: 'x', replacement: 'y', files: 'a.ts' },
        { projectRoot: root, query: 'x', replacement: 'y', files: [{ path: 'a.ts', expectedModifiedAt: 1 }] },
        {
          projectRoot: root,
          query: 'x',
          replacement: 'y',
          files: [{ path: 'a.ts', expectedModifiedAt: 1, expectedSize: 1, matches: [{ line: 1 }] }],
        },
      ]) {
        const rejected = (await handler({}, invalid)) as WorkbenchFsCallResult<unknown>
        assert.equal(rejected.ok ? 'ok' : rejected.code, 'VALIDATION')
      }
    })
  })
})
