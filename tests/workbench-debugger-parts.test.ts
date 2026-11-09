import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, test } from 'bun:test'

import { resolveWorkbenchNodeExecutable } from '../src/main/conversation/WorkbenchNodeRuntime'
import {
  buildWorkbenchDebugLaunchPlan,
  findFreeLoopbackPort,
  waitForInspectorEndpoint,
} from '../src/main/workspace/debug/WorkbenchDebugLaunch'
import { buildWorkbenchScriptUrlPattern } from '../src/main/workspace/debug/WorkbenchDebugSession'
import {
  toWorkbenchDebuggerValue,
  toWorkbenchDebuggerVariable,
} from '../src/main/workspace/debug/WorkbenchDebugValues'
import { decodeInlineSourceMap, WorkbenchSourceMap } from '../src/main/workspace/debug/WorkbenchSourceMap'
import { PathResolver } from '../src/main/workspace/PathResolver'
import { resolveWorkbenchPackageBin } from '../src/main/workspace/WorkbenchProcessLaunch'

import { createDebugCliQueryOwner } from './helpers/debugSessions'

/**
 * 调试器里不需要起程序就能验的几块：source map 的换算、脚本地址的匹配、值怎么写成一行文字、
 * 找依赖包的入口、等检查器就绪。
 */

void describe('debugger launch arguments', () => {
  void test('keeps Node and runner inspector arguments separate without mutating restart targets', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-debug-launch-')))
    const queries = createDebugCliQueryOwner()
    try {
      await writeFile(join(root, 'main file.cjs'), '')
      const context = {
        projectRoot: root,
        cwd: root,
        env: {
          ...process.env,
          PATH: [dirname(resolveWorkbenchNodeExecutable()), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
        },
        signal: new AbortController().signal,
        pathResolver: new PathResolver(),
        registerCliQuery: queries.registerCliQuery,
      }
      const argv = ['', 'two words', '"quoted"', '$HOME; $(literal) & %NAME%']
      Object.freeze(argv)
      const nodeTarget = { kind: 'node-script' as const, script: 'main file.cjs', argv }
      const first = await buildWorkbenchDebugLaunchPlan(nodeTarget, context, 9230)
      assert.deepEqual(first.process.argv, ['--inspect-brk=127.0.0.1:9230', join(root, 'main file.cjs'), ...argv])
      assert.equal(first.skipInitialPause, false)
      const next = await buildWorkbenchDebugLaunchPlan(nodeTarget, context, 9231)
      assert.deepEqual(next.process.argv, ['--inspect-brk=127.0.0.1:9231', join(root, 'main file.cjs'), ...argv])

      const runnerArgv = ['x', '--no-install', 'vitest', 'run', 'test file.ts', '-t', '^literal $(name)$', '--no-file-parallelism', '--testTimeout=0']
      Object.freeze(runnerArgv)
      const runner = await buildWorkbenchDebugLaunchPlan({
        kind: 'inspect-process',
        process: { kind: 'package-manager', program: 'bun', argv: runnerArgv },
      }, context, 9232)
      assert.deepEqual(runner.process.argv, [...runnerArgv, '--inspect-brk=127.0.0.1:9232'])
      assert.equal(runner.skipInitialPause, true)
    } finally {
      await queries.closeQueries()
      await rm(root, { recursive: true, force: true })
    }
  })
})

void describe('debugger source maps', () => {
  // 手写的一份映射（行列从 0 起）：
  //   生成第 0 行：列 0 → a.ts 0:0，列 4 → a.ts 0:6
  //   生成第 1 行：没有映射
  //   生成第 2 行：列 2 → a.ts 3:0，列 7 → 一段不指向任何源文件的，列 10 → c.ts 1:1
  //   生成第 3 行：列 16 → a.ts 40:0（数值大到要用两位 Base64 来写）
  const map = WorkbenchSourceMap.parse(
    JSON.stringify({
      version: 3,
      sources: ['../src/a.ts', 'webpack://bundle/b.ts', pathToFileURL(resolve('/abs/c.ts')).href],
      mappings: 'AAAA,IAAM;;EAGN,K,GEFC;gBFuCD',
    }),
    resolve('/project/dist')
  )

  void test('resolves the sources next to the map and ignores ones that are not files', () => {
    assert.ok(map)
    assert.deepEqual(map.sourcePaths, [resolve('/project/src/a.ts'), null, resolve('/abs/c.ts')])
    assert.equal(map.hasSource(resolve('/project/src/a.ts')), true)
    assert.equal(map.hasSource(resolve('/project/src/b.ts')), false)

    // sourceRoot 接在相对的源路径前面；绝对路径、带协议的不接。
    const rooted = WorkbenchSourceMap.parse(
      JSON.stringify({
        version: 3,
        sourceRoot: '../lib',
        sources: ['x.ts', resolve('/abs/y.ts'), pathToFileURL(resolve('/abs/z.ts')).href, 42],
        mappings: '',
      }),
      resolve('/project/dist')
    )
    assert.deepEqual(rooted?.sourcePaths, [resolve('/project/lib/x.ts'), resolve('/abs/y.ts'), resolve('/abs/z.ts'), null])
  })

  void test('turns a position in the generated code back into the source position', () => {
    assert.ok(map)
    const original = (line: number, column: number): string => {
      const position = map.originalPositionFor({ line, column })
      return position ? `${position.path}:${position.line}:${position.column}` : 'none'
    }
    assert.equal(original(0, 0), `${resolve('/project/src/a.ts')}:0:0`)
    assert.equal(original(0, 3), `${resolve('/project/src/a.ts')}:0:0`)
    assert.equal(original(0, 4), `${resolve('/project/src/a.ts')}:0:6`)
    assert.equal(original(0, 99), `${resolve('/project/src/a.ts')}:0:6`)
    // 这一行没有映射（打包器自己加的代码）。
    assert.equal(original(1, 0), 'none')
    // 在这一行第一段之前：转换器自己加的代码，不是源码里的任何一行。
    assert.equal(original(2, 0), 'none')
    assert.equal(original(2, 1), 'none')
    assert.equal(original(2, 2), `${resolve('/project/src/a.ts')}:3:0`)
    assert.equal(original(2, 6), `${resolve('/project/src/a.ts')}:3:0`)
    // 单字段 K 从列 7 起截断前面的映射，直到列 10 再次出现源码位置。
    assert.equal(original(2, 7), 'none')
    assert.equal(original(2, 9), 'none')
    assert.equal(original(2, 10), `${resolve('/abs/c.ts')}:1:1`)
    assert.equal(original(3, 16), `${resolve('/project/src/a.ts')}:40:0`)
    assert.equal(original(9, 0), 'none')
  })

  void test('finds where a source line lives in the generated code, sliding to the next line with code', () => {
    assert.ok(map)
    const generated = (path: string, line: number): string => {
      const position = map.generatedPositionFor(path, line)
      return position ? `${position.line}:${position.column} (source line ${position.originalLine})` : 'none'
    }
    assert.equal(generated(resolve('/project/src/a.ts'), 0), '0:0 (source line 0)')
    // 第 1、2 行没有生成代码（空行、注释、类型声明）：顺延到第 3 行。
    assert.equal(generated(resolve('/project/src/a.ts'), 1), '2:2 (source line 3)')
    assert.equal(generated(resolve('/project/src/a.ts'), 3), '2:2 (source line 3)')
    assert.equal(generated(resolve('/project/src/a.ts'), 4), '3:16 (source line 40)')
    // 后面再没有代码了。
    assert.equal(generated(resolve('/project/src/a.ts'), 41), 'none')
    assert.equal(generated(resolve('/abs/c.ts'), 0), '2:10 (source line 1)')
    assert.equal(generated(resolve('/project/src/missing.ts'), 0), 'none')
  })

  void test('does not accept anything that is not a plain v3 map', () => {
    assert.equal(WorkbenchSourceMap.parse('{not json', resolve('/p')), null)
    assert.equal(WorkbenchSourceMap.parse('null', resolve('/p')), null)
    assert.equal(WorkbenchSourceMap.parse('"text"', resolve('/p')), null)
    assert.equal(WorkbenchSourceMap.parse(JSON.stringify({ version: 2, sources: [], mappings: '' }), resolve('/p')), null)
    assert.equal(WorkbenchSourceMap.parse(JSON.stringify({ version: 3, mappings: '' }), resolve('/p')), null)
    // 分段的索引表（sections）没有 mappings：不认，按没有映射处理。
    assert.equal(WorkbenchSourceMap.parse(JSON.stringify({ version: 3, sections: [] }), resolve('/p')), null)

    // 写坏了的段不拖垮整份映射：丢掉那一段。
    const damaged = WorkbenchSourceMap.parse(
      JSON.stringify({ version: 3, sources: ['a.ts'], mappings: '!!!!,AAAA' }),
      resolve('/p')
    )
    assert.deepEqual(damaged?.originalPositionFor({ line: 0, column: 0 }), { path: resolve('/p/a.ts'), line: 0, column: 0 })
  })

  void test('reads a map embedded in the sourceMappingURL comment', () => {
    const json = JSON.stringify({ version: 3, sources: ['源🧭.ts'], mappings: 'AAAA' })
    const base64 = Buffer.from(json, 'utf8').toString('base64')
    assert.equal(decodeInlineSourceMap(`data:application/json;base64,${base64}`), json)
    assert.equal(decodeInlineSourceMap(`data:application/json;charset=utf-8;base64,${base64}`), json)
    assert.equal(decodeInlineSourceMap(`data:application/json,${encodeURIComponent(json)}`), json)
    assert.equal(decodeInlineSourceMap(`data:application/json,${json}`), json)
    // 不是内联的（一个文件路径、一个网址）：由调用方去读。
    assert.equal(decodeInlineSourceMap('main.js.map'), null)
    assert.equal(decodeInlineSourceMap('https://example.test/main.js.map'), null)
    assert.equal(decodeInlineSourceMap('data:text/plain;base64,AAAA'), null)
    assert.equal(decodeInlineSourceMap('data:application/json,%E0%A4%A'), null)
  })
})

void describe('debugger script address pattern', () => {
  void test('matches exactly this file, as a file: address or as a plain path', () => {
    const directory = join(tmpdir(), 'workbench-debugger-pattern', 'my project')
    const filePath = join(directory, 'a+b (1).test.ts')
    const fileUrl = pathToFileURL(filePath).href
    const pattern = new RegExp(buildWorkbenchScriptUrlPattern(filePath), 'u')
    // Node 给模块的地址（特殊字符按百分号编码）。
    assert.equal(pattern.test(fileUrl), true)
    // vm 里跑的脚本（Jest）给的是原样的路径。
    assert.equal(pattern.test(filePath), true)

    // 名字里的 `.`、`+`、括号都是字面量，不是正则的记号。
    assert.equal(pattern.test(join(directory, 'aab (1)xtest.ts')), false)
    assert.equal(pattern.test(`${filePath}x`), false)
    assert.equal(pattern.test(join(tmpdir(), 'other', 'workbench-debugger-pattern', 'my project', 'a+b (1).test.ts')), false)
    assert.equal(pattern.test(`${fileUrl}?v=1`), false)
  })
})

void describe('debugger values', () => {
  const text = (remoteObject: Parameters<typeof toWorkbenchDebuggerValue>[0]): string => {
    const value = toWorkbenchDebuggerValue(remoteObject)
    return `${value.type} ${value.text}`
  }

  void test('writes primitives the way the developer tools do', () => {
    assert.equal(text({ type: 'undefined' }), 'undefined undefined')
    assert.equal(text({ type: 'object', subtype: 'null', value: null }), 'null null')
    assert.equal(text({ type: 'boolean', value: false }), 'boolean false')
    assert.equal(text({ type: 'number', value: 1.5 }), 'number 1.5')
    // NaN、-0、Infinity 放不进 JSON：检查器另外给一段文字。
    assert.equal(text({ type: 'number', unserializableValue: 'NaN', description: 'NaN' }), 'number NaN')
    assert.equal(text({ type: 'number', unserializableValue: '-0' }), 'number -0')
    assert.equal(text({ type: 'bigint', unserializableValue: '10n', description: '10n' }), 'bigint 10n')
    assert.equal(text({ type: 'symbol', description: 'Symbol(tag)' }), 'symbol Symbol(tag)')
    // 字符串带引号，里面的引号、换行照 JSON 转义：一眼分得清 "1" 与 1。
    assert.equal(text({ type: 'string', value: 'two "words"\n' }), 'string "two \\"words\\"\\n"')
    assert.equal(toWorkbenchDebuggerValue({ type: 'string', value: 'x' }).objectId, null)

    const long = toWorkbenchDebuggerValue({ type: 'string', value: 'x'.repeat(5000) })
    assert.equal(long.text.length, 240)
    assert.equal(long.text.endsWith('…'), true)
  })

  void test('keeps only the signature of a function', () => {
    const describeFunction = (description: string): string => text({ type: 'function', description, objectId: 'f' })
    assert.equal(describeFunction('function add(a, b) {\n  return a + b\n}'), 'function ƒ add(a, b)')
    assert.equal(describeFunction('async function load() { await 1 }'), 'function ƒ load()')
    assert.equal(describeFunction('function* walk(tree) {}'), 'function ƒ walk(tree)')
    assert.equal(describeFunction('(a, b) => a + b'), 'function ƒ (a, b)')
    assert.equal(describeFunction('value => value * 2'), 'function ƒ value => value * 2')
    assert.equal(describeFunction('class Widget extends Base {\n  constructor() {}\n}'), 'function class Widget extends Base')
    assert.equal(toWorkbenchDebuggerValue({ type: 'function', description: 'function f() {}', objectId: 'f' }).objectId, 'f')
  })

  void test('gives objects a short preview and an id to expand them with', () => {
    assert.deepEqual(
      toWorkbenchDebuggerValue({
        type: 'object',
        className: 'Object',
        description: 'Object',
        objectId: 'object-1',
        preview: {
          type: 'object',
          description: 'Object',
          overflow: true,
          properties: [
            { name: 'id', type: 'number', value: '7' },
            { name: 'name', type: 'string', value: 'Ada' },
            { name: 'tags', type: 'object', subtype: 'array', value: 'Array(2)' },
            { name: 'nested', type: 'object', value: 'Object' },
            { name: 'none', type: 'object', subtype: 'null', value: 'null' },
            { name: 'missing', type: 'undefined' },
            { name: 'run', type: 'function', value: '' },
          ],
        },
      }),
      {
        type: 'object',
        text: '{id: 7, name: "Ada", tags: Array(2), nested: {…}, none: null, missing: undefined, run: ƒ, …}',
        objectId: 'object-1',
      }
    )
    assert.equal(
      text({
        type: 'object',
        subtype: 'array',
        className: 'Array',
        description: 'Array(3)',
        preview: {
          type: 'object',
          subtype: 'array',
          description: 'Array(3)',
          properties: [
            { name: '0', type: 'number', value: '1' },
            { name: '1', type: 'string', value: 'b' },
            { name: '2', type: 'object', value: 'Object' },
          ],
        },
      }),
      'object Array(3) [1, "b", {…}]'
    )
    // Map、Set 列它的项；类的实例前面带着类名。
    assert.equal(
      text({
        type: 'object',
        subtype: 'map',
        className: 'Map',
        description: 'Map(1)',
        preview: {
          type: 'object',
          subtype: 'map',
          description: 'Map(1)',
          entries: [
            { key: { type: 'string', description: 'key' }, value: { type: 'number', description: '1' } },
          ],
        },
      }),
      'object Map(1) {"key" => 1}'
    )
    assert.equal(
      text({
        type: 'object',
        subtype: 'set',
        className: 'Set',
        description: 'Set(2)',
        preview: {
          type: 'object',
          subtype: 'set',
          description: 'Set(2)',
          entries: [{ value: { type: 'number', description: '1' } }, { value: { type: 'object', description: 'Object' } }],
        },
      }),
      'object Set(2) {1, Object}'
    )
    assert.equal(
      text({
        type: 'object',
        className: 'Widget',
        description: 'Widget',
        preview: { type: 'object', description: 'Widget', properties: [{ name: 'size', type: 'number', value: '2' }] },
      }),
      'object Widget {size: 2}'
    )
    // 错误只留第一行（后面是整段调用栈）；日期、正则用它自己的写法。
    assert.equal(
      text({ type: 'object', subtype: 'error', className: 'TypeError', description: 'TypeError: not a function\n    at main (/p/a.js:1:1)' }),
      'object TypeError: not a function'
    )
    assert.equal(
      text({
        type: 'object',
        subtype: 'regexp',
        className: 'RegExp',
        description: '/a+/gu',
        preview: { type: 'object', subtype: 'regexp', description: '/a+/gu', properties: [{ name: 'lastIndex', type: 'number', value: '0' }] },
      }),
      'object /a+/gu'
    )
    // 没有预览（检查器没给）：用它的描述。
    assert.equal(text({ type: 'object', className: 'Object' }), 'object Object')
  })

  void test('does not call getters and marks variables that have no value yet', () => {
    assert.deepEqual(toWorkbenchDebuggerVariable({ name: 'count', value: { type: 'number', value: 3 } }), {
      name: 'count',
      value: { type: 'number', text: '3', objectId: null },
    })
    assert.deepEqual(
      toWorkbenchDebuggerVariable({ name: 'computed', get: { type: 'function', description: 'get computed() {}' } }),
      { name: 'computed', value: { type: 'accessor', text: '', objectId: null } }
    )
    // 执行还没走到声明的 let / const。
    assert.deepEqual(toWorkbenchDebuggerVariable({ name: 'later' }), {
      name: 'later',
      value: { type: 'unavailable', text: '', objectId: null },
    })
  })
})

void describe('debugger launch helpers', () => {
  void test('finds the executable of a package from a folder upwards, only inside the package', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-debugger-bin-')))
    const write = async (path: string, content: string): Promise<void> => {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
    }
    try {
      await write('node_modules/single/package.json', JSON.stringify({ name: 'single', bin: 'cli.js' }))
      await write('node_modules/single/cli.js', '')
      await write(
        'node_modules/@scope/tool/package.json',
        JSON.stringify({ bin: { tool: './dist/tool.js', gone: './dist/gone.js', up: '../../../outside.js' } })
      )
      await write('node_modules/@scope/tool/dist/tool.js', '')
      await write('outside.js', '')
      await write('node_modules/broken/package.json', '{not json')
      await write('node_modules/library/package.json', JSON.stringify({ main: 'index.js' }))
      // 子包自己装了另一份：离工作目录最近的那份优先。
      await write('packages/app/node_modules/single/package.json', JSON.stringify({ bin: { single: 'own.js' } }))
      await write('packages/app/node_modules/single/own.js', '')
      await mkdir(join(root, 'packages/app/src'), { recursive: true })

      const find = (from: string, packageName: string, binName = packageName): Promise<Nullable<string>> =>
        resolveWorkbenchPackageBin(join(root, from), packageName, binName)
      // 字符串 bin 只声明包名对应的入口，不能用未声明的名称启动。
      assert.equal(await find('.', 'single'), join(root, 'node_modules/single/cli.js'))
      assert.equal(await find('.', 'single', 'other'), null)
      assert.equal(await find('packages/app/src', 'single'), join(root, 'packages/app/node_modules/single/own.js'))
      assert.equal(await find('packages/app/src', '@scope/tool', 'tool'), join(root, 'node_modules/@scope/tool/dist/tool.js'))
      // 没有这个入口名、入口文件不在、入口指到包外面、清单坏了、包没有可执行入口、没装、名字不像包名。
      assert.equal(await find('.', '@scope/tool', 'other'), null)
      assert.equal(await find('.', '@scope/tool', 'gone'), null)
      assert.equal(await find('.', '@scope/tool', 'up'), null)
      assert.equal(await find('.', 'broken'), null)
      assert.equal(await find('.', 'library'), null)
      assert.equal(await find('.', 'not-installed'), null)
      assert.equal(await find('.', '../single'), null)
      assert.equal(await find('.', 'single/../single'), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('waits for the inspector on the loopback port and builds the address itself', async () => {
    const port = await findFreeLoopbackPort()
    assert.ok(port > 0 && port < 65_536)

    // 端口上还没有人：等到超时，或者程序已经退出就不再等。
    const startedAt = Date.now()
    assert.equal(await waitForInspectorEndpoint(port, { timeoutMs: 200, isCancelled: () => false }), null)
    assert.ok(Date.now() - startedAt >= 200)
    assert.equal(await waitForInspectorEndpoint(port, { timeoutMs: 60_000, isCancelled: () => true }), null)

    let body = JSON.stringify([{ id: 'abc-123', webSocketDebuggerUrl: 'ws://elsewhere.test:1/abc-123' }])
    const server: Server = createServer((request, response) => {
      if (request.url === '/json/list') response.end(body)
      else response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    try {
      // 地址由这边拼，只连本机这个端口——不用对方回的那个地址。
      assert.equal(
        await waitForInspectorEndpoint(port, { timeoutMs: 5_000, isCancelled: () => false }),
        `ws://127.0.0.1:${port}/abc-123`
      )
      // 答话的不是检查器（标识不像、回的不是列表）：当作没就绪。
      for (const answer of [JSON.stringify([{ id: '../x' }]), JSON.stringify({}), 'not json', '[]']) {
        body = answer
        assert.equal(await waitForInspectorEndpoint(port, { timeoutMs: 150, isCancelled: () => false }), null)
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
