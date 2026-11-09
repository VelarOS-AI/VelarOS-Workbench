import assert from 'node:assert/strict'

import { describe, mock, test } from 'bun:test'

import { formatWorkbenchDocumentBuiltin } from '../src/main/workspace/language/WorkbenchDocumentFormatter'
import { applyWorkbenchLanguageServiceEditsToContent } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import {
  detectWorkbenchIndentation,
  resolveWorkbenchIndentation,
  toWorkbenchLanguageServiceEditFormat,
} from '../src/renderer/src/models/editor/workbenchIndentation'
import { type WorkbenchLanguageServiceEditFormat } from '../src/shared/contracts/workbench'
import { WorkbenchLanguageChannels } from '../src/shared/workbenchLanguage'

import { createLanguageProject, type LanguageProjectFixture, positionOf } from './helpers/languageProject'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
}))

const FourSpaces: WorkbenchLanguageServiceEditFormat = { tabSize: 4, indentSize: 4, insertSpaces: true }
const Tabs: WorkbenchLanguageServiceEditFormat = { tabSize: 4, indentSize: 4, insertSpaces: false }

/** 没有 Prettier 的项目里格式化一个文件，返回格式化后的正文。 */
async function format(
  project: LanguageProjectFixture,
  path: string,
  content: string,
  editFormat?: WorkbenchLanguageServiceEditFormat
): Promise<string> {
  const result = await project.services.getFormat({
    projectRoot: project.projectRoot,
    path,
    content,
    format: editFormat,
  })
  const change = result.changes.find((candidate) => candidate.path === path)
  return change ? applyWorkbenchLanguageServiceEditsToContent(content, change.edits) : content
}

void describe('language service output follows the indentation of the file', () => {
  void test('formatting a four-space TypeScript file keeps four spaces', async () => {
    const tidy = [
      'export function add(a: number, b: number): number {',
      '    if (a > b) {',
      '        return a + b',
      '    }',
      '    return b',
      '}',
      '',
    ].join('\n')
    const untidy = [
      'export function add(a: number, b: number): number {',
      'if (a > b) {',
      '  return a+b',
      '        }',
      '    return b',
      '}',
      '',
    ].join('\n')
    const project = await createLanguageProject({ 'src/add.ts': tidy })
    try {
      // 已经排好的四格文件：格式化不再把它改成两格。
      assert.equal(await format(project, 'src/add.ts', tidy, FourSpaces), tidy)
      // 排乱了的按四格排回来。
      assert.equal(await format(project, 'src/add.ts', untidy, FourSpaces), tidy)
      // 请求里没带缩进（别的调用方）：照旧两格。
      assert.equal(
        await format(project, 'src/add.ts', untidy),
        tidy.replaceAll('        ', '\u0000').replaceAll('    ', '  ').replaceAll('\u0000', '    ')
      )
    } finally {
      await project.dispose()
    }
  })

  void test('formatting a tab-indented TypeScript file keeps tabs', async () => {
    const tidy = [
      'export class Counter {',
      '\tvalue = 0',
      '',
      '\tincrement(): number {',
      '\t\tthis.value += 1',
      '\t\treturn this.value',
      '\t}',
      '}',
      '',
    ].join('\n')
    const untidy = tidy.replaceAll('\t\t', '      ').replaceAll('\t', '  ')
    const project = await createLanguageProject({ 'src/counter.ts': tidy })
    try {
      assert.equal(await format(project, 'src/counter.ts', tidy, Tabs), tidy)
      assert.equal(await format(project, 'src/counter.ts', untidy, Tabs), tidy)
    } finally {
      await project.dispose()
    }
  })

  void test('code inserted by a completion is indented like the file', async () => {
    const content = [
      'interface Shape {',
      '    area(): number',
      '}',
      '',
      'export class Circle implements Shape {',
      '    ar',
      '}',
      '',
    ].join('\n')
    const project = await createLanguageProject({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
      'src/circle.ts': content,
    })
    try {
      const request = {
        projectRoot: project.projectRoot,
        path: 'src/circle.ts',
        content,
        position: positionOf(content, '    ar\n', 1),
      }
      const position = { ...request.position, column: request.position.column + 6, offset: request.position.offset + 6 }
      const insertTextFor = async (editFormat?: WorkbenchLanguageServiceEditFormat): Promise<string> => {
        const result = await project.services.getCompletions({ ...request, position, format: editFormat })
        const member = result.items.find((item) => item.label === 'area' && item.insertText?.includes('{'))
        assert.ok(member, result.items.filter((item) => item.label === 'area').map((item) => item.insertText).join(' | '))
        return member.insertText ?? ''
      }

      // 方法体比方法头深一级：四格的文件里是四格，制表符的文件里是一个制表符，没说时两格。
      assert.match(await insertTextFor(FourSpaces), /\{\n {4}\S/u)
      assert.match(await insertTextFor(Tabs), /\{\n\t\S/u)
      assert.match(await insertTextFor(), /\{\n {2}\S/u)
    } finally {
      await project.dispose()
    }
  })

  void test('the built-in JSON formatter uses the indentation of the file', async () => {
    const content = '{"name":"demo","files":["a","b"]}\n'
    const expected = (unit: string): string =>
      ['{', `${unit}"name": "demo",`, `${unit}"files": [`, `${unit}${unit}"a",`, `${unit}${unit}"b"`, `${unit}]`, '}', ''].join('\n')

    assert.equal(formatWorkbenchDocumentBuiltin({ extension: 'json', content, format: FourSpaces }), expected('    '))
    assert.equal(formatWorkbenchDocumentBuiltin({ extension: 'json', content, format: Tabs }), expected('\t'))
    assert.equal(formatWorkbenchDocumentBuiltin({ extension: 'json', content }), expected('  '))

    // 经语言服务的格式化请求（编辑器里 ⌥⌘L 走的那条路）也一样。
    const project = await createLanguageProject({ 'config.json': content })
    try {
      assert.equal(await format(project, 'config.json', content, FourSpaces), expected('    '))
      assert.equal(await format(project, 'config.json', content), expected('  '))
    } finally {
      await project.dispose()
    }
  })

  void test('the editor turns the indentation it resolved for a file into the request format', () => {
    const resolve = (path: string, content: string) =>
      toWorkbenchLanguageServiceEditFormat(
        resolveWorkbenchIndentation({ path, detected: detectWorkbenchIndentation(content), editorConfig: null })
      )

    assert.deepEqual(resolve('a.ts', 'function a() {\n    return 1\n}\n'), FourSpaces)
    assert.deepEqual(resolve('a.ts', 'function a() {\n\treturn 1\n}\n'), Tabs)
    // 认不出来（没有缩进过的行）用语言默认的两格。
    assert.deepEqual(resolve('a.ts', 'const a = 1\n'), { tabSize: 2, indentSize: 2, insertSpaces: true })
    // `.editorconfig` 写了的优先于正文里识别出来的。
    assert.deepEqual(
      toWorkbenchLanguageServiceEditFormat(
        resolveWorkbenchIndentation({
          path: 'a.ts',
          detected: { style: 'space', size: 2 },
          editorConfig: { indentStyle: 'space', indentSize: 4 },
        })
      ),
      FourSpaces
    )
  })
})

void describe('language service IPC boundary', () => {
  void test('passes a well-formed indentation on and drops a malformed one', async () => {
    const seen: unknown[] = []
    let admissions = 0
    const { registerWorkbenchLanguageServiceIpc } = await import(
      '../src/main/workspace/language/WorkbenchLanguageServiceIpc'
    )
    registerWorkbenchLanguageServiceIpc(
      {
        getFormat: async (request: { format?: unknown }) => {
          assert.equal(admissions, seen.length + 1)
          seen.push(request.format)
          return {}
        },
      } as never,
      {} as never,
      {
        assertProjectForWebContents: (sender, projectRoot) => {
          assert.equal(sender.id, 7)
          assert.equal(projectRoot, '/project')
          admissions += 1
        },
      }
    )
    const handler = ipcHandlers.get(WorkbenchLanguageChannels.format)
    assert.ok(handler)
    const base = { projectRoot: '/project', path: 'a.ts', content: '' }

    for (const format of [
      FourSpaces,
      Tabs,
      undefined,
      // 宽度为 0 会让 TypeScript 在排缩进时除以零；不是整数、离谱的宽度也一律当没给。
      { tabSize: 0, indentSize: 4, insertSpaces: true },
      { tabSize: 4, indentSize: 2.5, insertSpaces: true },
      { tabSize: 4, indentSize: 400, insertSpaces: true },
      { tabSize: 4, indentSize: 4, insertSpaces: 'yes' },
      'four',
    ])
      assert.equal(((await handler({ sender: { id: 7 } }, { ...base, format })) as { ok: boolean }).ok, true)

    assert.deepEqual(seen, [FourSpaces, Tabs, undefined, undefined, undefined, undefined, undefined, undefined])
  })
})
