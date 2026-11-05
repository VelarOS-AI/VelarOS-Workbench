import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, mock, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'

import { WorkbenchFsChannels } from '../src/shared/workbenchFs'
import {
  type WorkbenchTextFormat,
  WorkbenchUnencodableTextErrorCode,
} from '../src/shared/workbenchTextFormat'

import { refuseTrash } from './helpers/fakeTrash'

/**
 * 工作台不改用户没编辑过的字节：读盘认出编码、BOM 与换行符，能逐字节还原的才可编辑，
 * 保存按同一格式写回；写不出的字符拒绝保存，绝不写有损字节。
 */

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    on: () => undefined,
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    },
  },
}))

const { decodeWorkbenchText, encodeWorkbenchText } = await import('../src/main/workspace/TextCodec')
const { isLikelyTextFile } = await import('../src/main/workspace/TextFile')
const { createWorkbenchAppParts } = await import('../src/main/workspace/Parts')
const { WorkbenchProjectFileSystem } =
  await import('../src/main/workspace/WorkbenchProjectFileSystem')
const { registerWorkbenchFsIpc } = await import('../src/main/workspace/WorkbenchFsIpc')

/** 「中文测试」的 GBK 字节。 */
const GbkSample = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])

function bytes(...parts: Array<string | number[] | Uint8Array>): Buffer {
  return Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))
  )
}

function utf16be(text: string): Buffer {
  return Buffer.from(text, 'utf16le').swap16()
}

function assertRoundTrip(input: Uint8Array, format: WorkbenchTextFormat, content: string): void {
  const decoded = decodeWorkbenchText(input)
  assert.equal(decoded.content, content)
  assert.equal(decoded.encoding, format.encoding)
  assert.equal(decoded.eol, format.eol)
  assert.equal(decoded.textIssue, undefined)
  assert.deepEqual(encodeWorkbenchText(decoded.content, format), Buffer.from(input))
}

async function withProject(
  run: (paths: { root: string; data: string }) => Promise<void>
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-text-encoding-')))
  const data = await mkdtemp(join(tmpdir(), 'workbench-text-encoding-data-'))
  try {
    await run({ root, data })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
}

async function expectedStats(
  path: string
): Promise<{ expectedModifiedAt: number; expectedSize: number }> {
  const fileStats = await stat(path)
  return { expectedModifiedAt: fileStats.mtimeMs, expectedSize: fileStats.size }
}

void describe('Workbench text encoding detection and exact round trip', () => {
  void test('GBK bytes decode as GB18030 and write back byte for byte', () => {
    assertRoundTrip(GbkSample, { encoding: 'gb18030', eol: 'lf' }, '中文测试')
    assertRoundTrip(
      bytes(GbkSample, '\r\n', GbkSample, '\r\n'),
      { encoding: 'gb18030', eol: 'crlf' },
      '中文测试\n中文测试\n'
    )
  })

  void test('a UTF-8 BOM is kept out of the editor text and restored on save', () => {
    assertRoundTrip(
      bytes([0xef, 0xbb, 0xbf], 'const a = 1\n'),
      { encoding: 'utf-8-bom', eol: 'lf' },
      'const a = 1\n'
    )
    // BOM 之后紧跟的第二个 U+FEFF 是正文，不能再吞掉。
    assertRoundTrip(
      bytes([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], 'x'),
      { encoding: 'utf-8-bom', eol: 'lf' },
      '﻿x'
    )
  })

  void test('UTF-16 LE and BE with a BOM are text and round-trip with their line endings', () => {
    assertRoundTrip(
      bytes([0xff, 0xfe], Buffer.from('héllo\r\n世界😀\r\n', 'utf16le')),
      { encoding: 'utf-16le-bom', eol: 'crlf' },
      'héllo\n世界😀\n'
    )
    assertRoundTrip(
      bytes([0xfe, 0xff], utf16be('line 1\nline 2')),
      { encoding: 'utf-16be-bom', eol: 'lf' },
      'line 1\nline 2'
    )
    assert.equal(isLikelyTextFile(bytes([0xff, 0xfe], Buffer.from('plain text', 'utf16le'))), true)
    assert.equal(isLikelyTextFile(bytes([0xfe, 0xff], utf16be('plain text'))), true)
    // 码元里出现 NUL（UTF-32、二进制）照样按二进制拒绝；没有 BOM 的 0 字节也一样。
    assert.equal(
      isLikelyTextFile(bytes([0xff, 0xfe, 0x00, 0x00], Buffer.from('ab', 'utf16le'))),
      false
    )
    assert.equal(isLikelyTextFile(Buffer.from('plain text', 'utf16le')), false)
  })

  void test('CRLF and CR files give the editor LF text and get their line endings back', () => {
    assertRoundTrip(bytes('a\r\nb\r\n\r\nc'), { encoding: 'utf-8', eol: 'crlf' }, 'a\nb\n\nc')
    assertRoundTrip(bytes('a\rb\r'), { encoding: 'utf-8', eol: 'cr' }, 'a\nb\n')
    // 没有换行的文件、新文件按 LF。
    assertRoundTrip(new Uint8Array(), { encoding: 'utf-8', eol: 'lf' }, '')
    assertRoundTrip(bytes('single line'), { encoding: 'utf-8', eol: 'lf' }, 'single line')
  })

  void test('mixed line endings pick the dominant one and are flagged, never silently normalised', () => {
    const decoded = decodeWorkbenchText(bytes('a\r\nb\r\nc\nd\r\n'))
    assert.equal(decoded.content, 'a\nb\nc\nd\n')
    assert.equal(decoded.eol, 'crlf')
    assert.equal(decoded.textIssue, 'mixed-eol')
    // 用户选定换行符后才统一：按占多数的一种写回。
    assert.deepEqual(
      encodeWorkbenchText(decoded.content, { encoding: 'utf-8', eol: 'crlf' }),
      bytes('a\r\nb\r\nc\r\nd\r\n')
    )
    // LF 与 CRLF 一样多时取 LF；单独的 CR 也算一种换行。
    assert.equal(decodeWorkbenchText(bytes('a\nb\r\n')).eol, 'lf')
    assert.equal(decodeWorkbenchText(bytes('a\rb\n')).textIssue, 'mixed-eol')
  })

  void test('bytes that no supported encoding decodes open read-only as undecodable', () => {
    const decoded = decodeWorkbenchText(bytes('abc', [0xff], 'def'))
    assert.equal(decoded.encoding, 'utf-8')
    assert.equal(decoded.textIssue, 'undecodable')
    assert.equal(decoded.content, 'abc�def')
    // 奇数长度的 UTF-16、不成对的代理项同样认不出。
    assert.equal(
      decodeWorkbenchText(bytes([0xff, 0xfe, 0x41, 0x00, 0x42])).textIssue,
      'undecodable'
    )
    assert.equal(
      decodeWorkbenchText(bytes([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00])).textIssue,
      'undecodable'
    )
  })

  void test('GB18030 text that would not write back exactly is irreversible', () => {
    // 四字节序列（U+0080）解得出，但编码表只有单双字节；A3A0 与 A1A1 都解成 U+3000。
    for (const input of [
      bytes(GbkSample, [0x81, 0x30, 0x81, 0x30]),
      bytes(GbkSample, [0xa3, 0xa0]),
    ]) {
      const decoded = decodeWorkbenchText(input)
      assert.equal(decoded.encoding, 'gb18030')
      assert.equal(decoded.textIssue, 'irreversible')
    }
  })

  void test('characters the target encoding cannot represent are refused, never written lossily', () => {
    assert.throws(
      () => encodeWorkbenchText('中文\n测试😀', { encoding: 'gb18030', eol: 'lf' }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === WorkbenchUnencodableTextErrorCode &&
        /第 2 行第 3 列/u.test(error.message) &&
        error.message.includes('😀') &&
        /转换为 UTF-8/u.test(error.message)
    )
    assert.throws(
      () => encodeWorkbenchText('ok\uD800', { encoding: 'utf-8', eol: 'lf' }),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION'
    )
    // 统一换行后再换成目标换行符：`\r\n` 不会变成 `\r\r\n`。
    assert.deepEqual(
      encodeWorkbenchText('a\r\nb\rc\n', { encoding: 'utf-16be', eol: 'crlf' }),
      utf16be('a\r\nb\r\nc\r\n')
    )
  })
})

void describe('Workbench file reads and saves keep the file format', () => {
  void test('a GBK file opens as Chinese text and a one-character edit writes GBK bytes', async () => {
    await withProject(async ({ root, data }) => {
      const filePath = join(root, 'legacy.txt')
      await writeFile(filePath, GbkSample)
      const read = await new WorkbenchProjectFileSystem().readTextFile({
        projectRoot: root,
        path: 'legacy.txt',
      })
      assert.equal(read.content, '中文测试')
      assert.equal(read.encoding, 'gb18030')
      assert.equal(read.textIssue, undefined)

      const saved = await createWorkbenchAppParts(data, {
        moveToTrash: refuseTrash,
      }).files.saveFile({
        projectRoot: root,
        path: 'legacy.txt',
        content: `${read.content}!`,
        encoding: read.encoding,
        eol: read.eol,
        ...(await expectedStats(filePath)),
      })
      assert.deepEqual(await readFile(filePath), bytes(GbkSample, '!'))
      assert.equal(saved.content, '中文测试!')
      assert.equal(saved.encoding, 'gb18030')
      assert.equal(saved.size, GbkSample.length + 1)
    })
  })

  void test('editing one line of a CRLF file changes only that line', async () => {
    await withProject(async ({ root, data }) => {
      const filePath = join(root, 'windows.ts')
      await writeFile(filePath, 'one\r\ntwo\r\nthree\r\n')
      const read = await new WorkbenchProjectFileSystem().readTextFile({
        projectRoot: root,
        path: 'windows.ts',
      })
      assert.equal(read.content, 'one\ntwo\nthree\n')
      assert.equal(read.eol, 'crlf')

      await createWorkbenchAppParts(data, { moveToTrash: refuseTrash }).files.saveFile({
        projectRoot: root,
        path: 'windows.ts',
        content: read.content.replace('two', 'TWO'),
        encoding: read.encoding,
        eol: read.eol,
        ...(await expectedStats(filePath)),
      })
      assert.equal(await readFile(filePath, 'utf8'), 'one\r\nTWO\r\nthree\r\n')
    })
  })

  void test('a save without a format keeps the disk format and refuses one that cannot round-trip', async () => {
    await withProject(async ({ root, data }) => {
      const files = createWorkbenchAppParts(data, { moveToTrash: refuseTrash }).files
      const bomPath = join(root, 'bom.txt')
      await writeFile(bomPath, bytes([0xef, 0xbb, 0xbf], 'a\r\nb\r\n'))
      await files.saveFile({ projectRoot: root, path: 'bom.txt', content: 'a\nb\nc\n' })
      assert.deepEqual(await readFile(bomPath), bytes([0xef, 0xbb, 0xbf], 'a\r\nb\r\nc\r\n'))

      const mixedPath = join(root, 'mixed.txt')
      const mixed = bytes('a\r\nb\nc\r\n')
      await writeFile(mixedPath, mixed)
      await assert.rejects(
        () => files.saveFile({ projectRoot: root, path: 'mixed.txt', content: 'a\nb\nc\nd\n' }),
        (error: unknown) => error instanceof AppError && error.code === 'VALIDATION'
      )
      assert.deepEqual(await readFile(mixedPath), mixed)
    })
  })

  void test('an unencodable character refuses the save and leaves the file untouched', async () => {
    await withProject(async ({ root, data }) => {
      const filePath = join(root, 'legacy.txt')
      await writeFile(filePath, GbkSample)
      await assert.rejects(
        async () =>
          createWorkbenchAppParts(data, { moveToTrash: refuseTrash }).files.saveFile({
            projectRoot: root,
            path: 'legacy.txt',
            content: '中文测试😀',
            encoding: 'gb18030',
            eol: 'lf',
            ...(await expectedStats(filePath)),
          }),
        (error: unknown) =>
          error instanceof AppError && error.code === WorkbenchUnencodableTextErrorCode
      )
      assert.deepEqual(await readFile(filePath), Buffer.from(GbkSample))
    })
  })

  void test('converting to UTF-8 and changing line endings rewrite the file only when asked', async () => {
    await withProject(async ({ root, data }) => {
      const files = createWorkbenchAppParts(data, { moveToTrash: refuseTrash }).files
      const filePath = join(root, 'legacy.txt')
      await writeFile(filePath, bytes(GbkSample, '\r\n'))
      const converted = await files.saveFile({
        projectRoot: root,
        path: 'legacy.txt',
        content: '中文测试\n',
        encoding: 'utf-8',
        eol: 'lf',
        ...(await expectedStats(filePath)),
      })
      assert.equal(await readFile(filePath, 'utf8'), '中文测试\n')
      assert.equal(converted.encoding, 'utf-8')
      assert.equal(converted.eol, 'lf')

      const utf16Path = join(root, 'wide.txt')
      await writeFile(utf16Path, bytes([0xff, 0xfe], Buffer.from('x\ny\n', 'utf16le')))
      const read = await new WorkbenchProjectFileSystem().readTextFile({
        projectRoot: root,
        path: 'wide.txt',
      })
      assert.equal(read.encoding, 'utf-16le-bom')
      await files.saveFile({
        projectRoot: root,
        path: 'wide.txt',
        content: 'x\ny\nz\n',
        encoding: read.encoding,
        eol: 'crlf',
        ...(await expectedStats(utf16Path)),
      })
      assert.deepEqual(
        await readFile(utf16Path),
        bytes([0xff, 0xfe], Buffer.from('x\r\ny\r\nz\r\n', 'utf16le'))
      )
    })
  })

  void test('a restored deleted file keeps its original format; local history keeps text', async () => {
    await withProject(async ({ root, data }) => {
      const files = createWorkbenchAppParts(data, { moveToTrash: refuseTrash }).files
      const restored = await files.restoreMissingFile({
        projectRoot: root,
        path: 'restored.txt',
        content: '中文测试\n',
        encoding: 'gb18030',
        eol: 'crlf',
      })
      assert.deepEqual(await readFile(join(root, 'restored.txt')), bytes(GbkSample, '\r\n'))
      assert.equal(restored.encoding, 'gb18030')
      assert.equal(restored.content, '中文测试\n')

      await files.saveFile({
        projectRoot: root,
        path: 'restored.txt',
        content: '中文\n',
        ...(await expectedStats(join(root, 'restored.txt'))),
      })
      const history = files.listLocalHistory({ projectRoot: root, path: 'restored.txt' })
      const snapshot = files.readLocalHistorySnapshot({
        projectRoot: root,
        path: 'restored.txt',
        id: history.entries[0]!.id,
      })
      assert.equal(snapshot.content, '中文\n')
    })
  })

  void test('the save IPC rejects unknown formats instead of guessing', async () => {
    await withProject(async ({ root, data }) => {
      await writeFile(join(root, 'a.txt'), 'a\n')
      registerWorkbenchFsIpc(
        {} as never,
        createWorkbenchAppParts(data, { moveToTrash: refuseTrash }),
        {} as never
      )
      const handler = ipcHandlers.get(WorkbenchFsChannels.saveFile)
      assert.ok(handler)
      const save = async (request: Record<string, unknown>) =>
        (await handler({}, { projectRoot: root, path: 'a.txt', content: 'b\n', ...request })) as {
          ok: boolean
        }

      assert.equal((await save({ encoding: 'latin1' })).ok, false)
      assert.equal((await save({ eol: '\r\n' })).ok, false)
      assert.equal((await save({ encoding: 'utf-8', eol: 'crlf' })).ok, true)
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'b\r\n')
    })
  })
})
