import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { describe, setDefaultTimeout, test } from 'bun:test'
import ts from 'typescript'

import type { WorkbenchDebuggerBreakpointStatus } from '../src/shared/workbenchDebugger'

import {
  createDebugTestProject,
  frameSummary,
  isProcessAlive,
  variablesOf,
} from './helpers/debugSessions'

/**
 * 这些测试调试的是真的 Node 程序：起子进程、经检查器连上去、下断点、单步、读变量。只连本机回环地址。
 */

// 每一步都要等子进程与检查器：机器忙的时候默认的 5 秒不够。等不到时由 `next()` 带着已收到的事件报错。
setDefaultTimeout(30_000)

const MainScript = [
  'function add(a, b) {', // 1
  '  const sum = a + b', // 2
  '  return sum', // 3
  '}', // 4
  'const values = { list: [1, 2, 3], nested: { deep: true }, label: "two words" }', // 5
  'const total = add(2, 3)', // 6
  'debugger', // 7
  'console.log("total", total, values.list.length)', // 8
  '',
].join('\n')

void describe('debugging a Node.js program', () => {
  void test('pauses at a breakpoint, reads variables, steps, evaluates, continues and exits', async () => {
    const project = await createDebugTestProject({ 'main.js': MainScript })
    try {
      const started = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [{ path: 'main.js', line: 2 }],
      })
      assert.match(started.command, /^node --inspect-brk=127\.0\.0\.1:\d+ ['"]main\.js['"]$/u)
      assert.equal(started.cwd, project.root)
      await project.next('attached')

      // 停在断点上：调用栈最里层是 add，外面是模块顶层。
      const atBreakpoint = await project.next('paused')
      assert.equal(atBreakpoint.reason, 'breakpoint')
      assert.deepEqual(atBreakpoint.frames.slice(0, 2).map(frameSummary), [
        'add@main.js:2',
        '(anonymous)@main.js:6',
      ])
      assert.equal(atBreakpoint.frames[0]!.location.source, `${project.root}/main.js`)
      const before = await variablesOf(project, started.sessionId, atBreakpoint.frames[0]!, 'local')
      assert.deepEqual(
        [before.a, before.b, before.sum].map((value) => `${value?.type}:${value?.text}`),
        // 还没执行到 sum 的声明：没有值可读。
        ['number:2', 'number:3', 'unavailable:']
      )

      // 单步越过这一行：sum 有值了。
      await project.sessions.controlDebugSession({ sessionId: started.sessionId, action: 'step-over' }, 1)
      await project.next('resumed')
      const afterStep = await project.next('paused')
      assert.equal(afterStep.reason, 'step')
      assert.equal(frameSummary(afterStep.frames[0]), 'add@main.js:3')
      const after = await variablesOf(project, started.sessionId, afterStep.frames[0]!, 'local')
      assert.equal(after.sum?.text, '5')

      // 在选中的那一帧里求值；外层那一帧看不到 a。
      const inner = afterStep.frames[0]!.id
      const outer = afterStep.frames[1]!.id
      const evaluate = (expression: string, frameId?: string, sideEffectFree = false) =>
        project.sessions.evaluate({ sessionId: started.sessionId, expression, frameId, sideEffectFree }, 1)
      assert.deepEqual(await evaluate('a * 10 + sum', inner), {
        value: { type: 'number', text: '25', objectId: null },
        error: null,
      })
      assert.equal((await evaluate('values.label', outer)).value?.text, '"two words"')
      const missing = await evaluate('a', outer)
      assert.equal(missing.value, null)
      assert.match(missing.error ?? '', /ReferenceError: a is not defined/u)
      // 悬停看值用的「只看不动」：有副作用的表达式不求。
      assert.equal((await evaluate('sum', inner, true)).value?.text, '5')
      assert.equal((await evaluate('values.list.push(4)', outer, true)).value, null)
      assert.equal((await evaluate('values.list.length', outer)).value?.text, '3')

      // 步出回到模块顶层：赋值那一行已经没有可停的地方了，停在下一句上。
      await project.sessions.controlDebugSession({ sessionId: started.sessionId, action: 'step-out' }, 1)
      const atStatement = await project.next('paused')
      assert.equal(atStatement.reason, 'step')
      assert.equal(frameSummary(atStatement.frames[0]), '(anonymous)@main.js:7')

      // 对象按需展开：先是一行预览，展开才取它的属性。
      const moduleScope = await variablesOf(project, started.sessionId, atStatement.frames[0]!, 'local')
      assert.equal(moduleScope.total?.text, '5')
      assert.equal(
        moduleScope.values?.text,
        '{list: Array(3), nested: {…}, label: "two words"}'
      )
      assert.ok(moduleScope.values?.objectId)
      const properties = await project.sessions.getVariables(
        { sessionId: started.sessionId, objectId: moduleScope.values.objectId },
        1
      )
      assert.equal(properties.truncated, false)
      const list = properties.variables.find((variable) => variable.name === 'list')
      assert.equal(list?.value.text, 'Array(3) [1, 2, 3]')
      const items = await project.sessions.getVariables(
        { sessionId: started.sessionId, objectId: list!.value.objectId! },
        1
      )
      assert.deepEqual(
        items.variables.slice(0, 4).map((variable) => `${variable.name}=${variable.value.text}`),
        ['0=1', '1=2', '2=3', 'length=3']
      )

      // 继续跑完：程序自己退出，输出照常。
      await project.sessions.controlDebugSession({ sessionId: started.sessionId, action: 'continue' }, 1)
      const ended = await project.next('ended')
      assert.deepEqual([ended.reason, ended.exitCode, ended.message], ['exited', 0, null])
      assert.match(project.launched[0]!.output(), /total 5 3/u)
      assert.equal(isProcessAlive(project.launched[0]!.pid), false)
      // 会话结束之后再发命令：说它已经结束了。
      await assert.rejects(
        project.sessions.controlDebugSession({ sessionId: started.sessionId, action: 'continue' }, 1),
        /调试会话已结束/u
      )
    } finally {
      await project.dispose()
    }
  })

  void test('reports which breakpoints match code and takes changes while the program runs', async () => {
    const project = await createDebugTestProject({
      'main.js': [
        "const { helper } = require('./lib.js')", // 1
        'let count = 0', // 2
        'count += helper(1)', // 3
        'count += helper(2)', // 4
        "console.log('count', count)", // 5
        '',
      ].join('\n'),
      'lib.js': [
        'exports.helper = function helper(n) {', // 1
        '  // a line without code', // 2
        '  const doubled = n * 2', // 3
        '  return doubled', // 4
        '}', // 5
        '',
      ].join('\n'),
      'never-loaded.js': 'console.log("not part of this run")\n',
    })
    const statusOf = (statuses: readonly WorkbenchDebuggerBreakpointStatus[]): string[] =>
      statuses.map(
        (status) =>
          `${status.path}:${status.line} ${status.verified ? `verified@${status.resolvedLine}` : 'unverified'}`
      )
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [
          { path: 'main.js', line: 3 },
          { path: 'lib.js', line: 2 },
          { path: 'never-loaded.js', line: 1 },
          { path: 'deleted.js', line: 1 },
        ],
      })
      // 程序还没加载任何文件：都还没对上。
      await project.next('attached')
      assert.deepEqual(statusOf((await project.next('breakpoints')).breakpoints), [
        'main.js:3 unverified',
        'lib.js:2 unverified',
        'never-loaded.js:1 unverified',
        'deleted.js:1 unverified',
      ])

      const first = await project.next('paused')
      assert.equal(first.reason, 'breakpoint')
      assert.equal(frameSummary(first.frames[0]), '(anonymous)@main.js:3')
      // 停下时 main.js、lib.js 都加载了；没有代码的那一行顺延到下一句。没加载的文件、不存在的文件对不上。
      const loaded = project.events.findLast((event) => event.type === 'breakpoints')
      assert.deepEqual(statusOf(loaded?.type === 'breakpoints' ? loaded.breakpoints : []), [
        'main.js:3 verified@3',
        'lib.js:2 verified@3',
        'never-loaded.js:1 unverified',
        'deleted.js:1 unverified',
      ])

      // 停着的时候改断点：摘掉 main.js:3，加上 main.js:5。
      const changed = await project.sessions.setBreakpoints(
        {
          sessionId,
          breakpoints: [
            { path: 'lib.js', line: 2 },
            { path: 'main.js', line: 5 },
          ],
        },
        1
      )
      assert.deepEqual(statusOf(changed.breakpoints), ['lib.js:2 verified@3', 'main.js:5 verified@5'])

      const resume = (): Promise<void> =>
        project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      await resume()
      const inHelper = await project.next('paused')
      assert.deepEqual(inHelper.frames.slice(0, 2).map(frameSummary), [
        'helper@lib.js:3',
        '(anonymous)@main.js:3',
      ])
      assert.equal((await variablesOf(project, sessionId, inHelper.frames[0]!, 'local')).n?.text, '1')
      await resume()
      const again = await project.next('paused')
      assert.equal((await variablesOf(project, sessionId, again.frames[0]!, 'local')).n?.text, '2')

      // 跑着的时候（这里是停着）摘掉 lib.js 的断点：不再停在那里。
      await project.sessions.setBreakpoints({ sessionId, breakpoints: [{ path: 'main.js', line: 5 }] }, 1)
      await resume()
      const last = await project.next('paused')
      assert.equal(frameSummary(last.frames[0]), '(anonymous)@main.js:5')
      await resume()
      assert.equal((await project.next('ended')).exitCode, 0)
      assert.match(project.launched[0]!.output(), /count 6/u)
    } finally {
      await project.dispose()
    }
  })

  void test('stops on an uncaught exception only when asked to', async () => {
    const project = await createDebugTestProject({
      'main.js': [
        "function fail(label) { throw new Error('boom ' + label) }", // 1
        "try { fail('caught') } catch (error) { console.log(error.message) }", // 2
        'debugger', // 3
        "fail('uncaught')", // 4
        '',
      ].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        pauseOnUncaughtExceptions: false,
      })
      // 接住了的异常不停；先到的是 debugger 语句。
      const statement = await project.next('paused')
      assert.deepEqual([statement.reason, statement.exception], ['other', null])
      assert.equal(frameSummary(statement.frames[0]), '(anonymous)@main.js:3')

      // 跑到一半打开「未捕获的异常」。
      await project.sessions.setExceptionPause({ sessionId, uncaught: true }, 1)
      await project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      const thrown = await project.next('paused')
      assert.equal(thrown.reason, 'exception')
      assert.deepEqual(thrown.frames.slice(0, 2).map(frameSummary), [
        'fail@main.js:1',
        '(anonymous)@main.js:4',
      ])
      assert.equal(thrown.exception?.type, 'object')
      assert.equal(thrown.exception?.text, 'Error: boom uncaught')
      assert.equal((await variablesOf(project, sessionId, thrown.frames[0]!, 'local')).label?.text, '"uncaught"')

      await project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      const ended = await project.next('ended')
      assert.deepEqual([ended.reason, ended.exitCode], ['exited', 1])
      assert.match(project.launched[0]!.output(), /caught[\s\S]*Error: boom uncaught/u)
    } finally {
      await project.dispose()
    }

    // 没打开时，未捕获的异常不停，程序直接以非零码退出。
    const quiet = await createDebugTestProject({ 'main.js': "throw new Error('no pause')\n" })
    try {
      await quiet.start({ target: { kind: 'node-script', script: 'main.js' } })
      assert.equal((await quiet.next('ended')).exitCode, 1)
      assert.equal(quiet.events.some((event) => event.type === 'paused'), false)
    } finally {
      await quiet.dispose()
    }
  })
})

/** 一份会让生成代码的行号与源码对不上的 TypeScript：接口整段消失，枚举展开成几行。 */
const TypeScriptSource = [
  'interface Pair {', // 1
  '  left: number', // 2
  '  right: number', // 3
  '}', // 4
  '', // 5
  'enum Mode {', // 6
  "  Add = 'add',", // 7
  '}', // 8
  '', // 9
  'function combine(pair: Pair, mode: Mode): number {', // 10
  '  const sum: number = pair.left + pair.right', // 11
  '  return mode === Mode.Add ? sum : -sum', // 12
  '}', // 13
  '', // 14
  'const pair: Pair = { left: 2, right: 3 }', // 15
  'const result = combine(pair, Mode.Add)', // 16
  "console.log('result', result)", // 17
  '',
].join('\n')

void describe('debugging TypeScript through source maps', () => {
  void test('breakpoints set in the .ts source work in compiled output with a source map file', async () => {
    const compiled = ts.transpileModule(TypeScriptSource, {
      fileName: 'main.ts',
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        sourceMap: true,
      },
    })
    // 产物放在 dist/，映射指回 src/ 里的源码。
    const map = { ...(JSON.parse(compiled.sourceMapText!) as object), sources: ['../src/main.ts'] }
    assert.notEqual(
      compiled.outputText.split('\n').findIndex((line) => line.includes('pair.left + pair.right')),
      10,
      'the generated line must differ from the source line for this test to mean anything'
    )
    const project = await createDebugTestProject({
      'src/main.ts': TypeScriptSource,
      'dist/main.js': compiled.outputText,
      'dist/main.js.map': JSON.stringify(map),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'dist/main.js' },
        breakpoints: [
          { path: 'src/main.ts', line: 11 },
          // 主脚本的第一句（顶层代码）：脚本一开始执行就到，断点必须在那之前下好。
          { path: 'src/main.ts', line: 6 },
          // 接口声明没有生成代码，顺延到后面第一句有代码的。
          { path: 'src/main.ts', line: 2 },
        ],
      })

      const top = await project.next('paused')
      assert.equal(top.reason, 'breakpoint')
      assert.equal(frameSummary(top.frames[0]), '(anonymous)@src/main.ts:6')
      assert.equal(top.frames[0]!.location.source, `${project.root}/src/main.ts`)
      const statuses = project.events.findLast((event) => event.type === 'breakpoints')
      assert.deepEqual(
        statuses?.type === 'breakpoints'
          ? statuses.breakpoints.map((status) => [status.line, status.verified, status.resolvedLine])
          : [],
        [
          [11, true, 11],
          [6, true, 6],
          [2, true, 6],
        ]
      )

      await project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      const inFunction = await project.next('paused')
      assert.equal(inFunction.reason, 'breakpoint')
      // 调用栈的每一帧都换回了源码的位置。
      assert.deepEqual(inFunction.frames.slice(0, 2).map(frameSummary), [
        'combine@src/main.ts:11',
        '(anonymous)@src/main.ts:16',
      ])
      const locals = await variablesOf(project, sessionId, inFunction.frames[0]!, 'local')
      assert.equal(locals.pair?.text, '{left: 2, right: 3}')
      assert.equal(locals.mode?.text, '"add"')

      // 单步也按源码的行走。
      await project.sessions.controlDebugSession({ sessionId, action: 'step-over' }, 1)
      const stepped = await project.next('paused')
      assert.equal(frameSummary(stepped.frames[0]), 'combine@src/main.ts:12')
      assert.equal(
        (await project.sessions.evaluate({ sessionId, expression: 'sum', frameId: stepped.frames[0]!.id }, 1))
          .value?.text,
        '5'
      )

      await project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      assert.equal((await project.next('ended')).exitCode, 0)
      assert.match(project.launched[0]!.output(), /result 5/u)
    } finally {
      await project.dispose()
    }
  })

  void test('breakpoints work when a loader compiles the .ts file in place with an inline source map', async () => {
    // 与 tsx 同样的做法：加载 .ts 时当场转成 JS，脚本地址还是那个 .ts 文件，映射内联在代码末尾。
    const typescriptPath = createRequire(import.meta.url).resolve('typescript')
    const project = await createDebugTestProject({
      'loader.cjs': [
        `const ts = require(${JSON.stringify(typescriptPath)})`,
        "const fs = require('node:fs')",
        "require.extensions['.ts'] = (module, filename) => {",
        "  const source = fs.readFileSync(filename, 'utf8')",
        '  const { outputText } = ts.transpileModule(source, {',
        '    fileName: filename,',
        '    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, inlineSourceMap: true },',
        '  })',
        '  module._compile(outputText, filename)',
        '}',
        '',
      ].join('\n'),
      'start.cjs': "require('./loader.cjs')\nrequire('./app.ts')\n",
      'app.ts': TypeScriptSource,
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'start.cjs' },
        breakpoints: [
          // 被加载模块的顶层第一句：它不是主脚本，只能靠脚本开始执行前的那次停顿把断点下好。
          { path: 'app.ts', line: 6 },
          { path: 'app.ts', line: 12 },
        ],
      })

      const top = await project.next('paused')
      assert.equal(top.reason, 'breakpoint')
      assert.equal(frameSummary(top.frames[0]), '(anonymous)@app.ts:6')

      await project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      const inFunction = await project.next('paused')
      assert.deepEqual(inFunction.frames.slice(0, 2).map(frameSummary), [
        'combine@app.ts:12',
        '(anonymous)@app.ts:16',
      ])
      assert.equal((await variablesOf(project, sessionId, inFunction.frames[0]!, 'local')).sum?.text, '5')
      const statuses = project.events.findLast((event) => event.type === 'breakpoints')
      assert.deepEqual(
        statuses?.type === 'breakpoints'
          ? statuses.breakpoints.map((status) => [status.line, status.verified, status.resolvedLine])
          : [],
        [
          [6, true, 6],
          [12, true, 12],
        ]
      )

      // 程序跑着的时候再加一个断点：脚本已经加载，直接按映射下。
      const changed = await project.sessions.setBreakpoints(
        {
          sessionId,
          breakpoints: [
            { path: 'app.ts', line: 12 },
            { path: 'app.ts', line: 17 },
          ],
        },
        1
      )
      assert.deepEqual(
        changed.breakpoints.map((status) => [status.line, status.verified]),
        [
          [12, true],
          [17, true],
        ]
      )
      await project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      assert.equal(frameSummary((await project.next('paused')).frames[0]), '(anonymous)@app.ts:17')
      await project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)
      assert.equal((await project.next('ended')).exitCode, 0)
      // 没有在别处多停：一共就这三次。
      assert.equal(project.events.filter((event) => event.type === 'paused').length, 3)
    } finally {
      await project.dispose()
    }
  })

  void test('breakpoints work in ES modules a loader turns into one line of code (the way tsx does)', async () => {
    // tsx 交给 Node 的代码是压成一行的：有的文件最前面是它自己加的辅助代码，后面才是用户的语句，映射全靠列号。
    // 这里用一个最小的加载钩子做同样的事：每个源码行变成那一行里的一段。
    const hooks = [
      "import { readFile } from 'node:fs/promises'",
      "import { fileURLToPath } from 'node:url'",
      "const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'",
      'function vlq(value) {',
      '  let rest = value < 0 ? (-value << 1) | 1 : value << 1',
      "  let text = ''",
      '  do {',
      '    let digit = rest & 31',
      '    rest >>>= 5',
      '    if (rest > 0) digit |= 32',
      '    text += digits[digit]',
      '  } while (rest > 0)',
      '  return text',
      '}',
      'export async function load(url, context, nextLoad) {',
      "  if (!url.endsWith('.ts')) return nextLoad(url, context)",
      "  const lines = (await readFile(fileURLToPath(url), 'utf8')).split('\\n')",
      // 与 esbuild 一样，只在用得上的文件里加辅助代码（有函数的文件）：没加的文件里第一句就是用户的语句。
      "  let code = lines.some((text) => text.includes('function ')) ? 'var __helper=Object.defineProperty;' : ''",
      '  const segments = []',
      '  let previous = { column: 0, line: 0, indent: 0 }',
      '  for (const [line, text] of lines.entries()) {',
      "    if (!text.trim() || text.trim().startsWith('//')) continue",
      '    const indent = text.length - text.trimStart().length',
      '    segments.push(vlq(code.length - previous.column) + vlq(0) + vlq(line - previous.line) + vlq(indent - previous.indent))',
      '    previous = { column: code.length, line, indent }',
      "    code += text.trim() + ';'",
      '  }',
      "  const map = { version: 3, sources: [url], names: [], mappings: segments.join(',') }",
      "  const inline = Buffer.from(JSON.stringify(map)).toString('base64')",
      "  return { format: 'module', shortCircuit: true, source: code + '\\n//# sourceMappingURL=data:application/json;base64,' + inline }",
      '}',
      '',
    ].join('\n')
    const project = await createDebugTestProject({
      'package.json': JSON.stringify({ type: 'module' }),
      'hooks.mjs': hooks,
      'register.mjs': "import { register } from 'node:module'\nregister('./hooks.mjs', import.meta.url)\n",
      'lib.ts': [
        '// the first statement of a dependency: it runs before the main module', // 1
        'const created = Date.now()', // 2
        'export function scale(pair, factor) {', // 3
        '  const sum = pair.a + pair.b', // 4
        '  return sum * factor + (created > 0 ? 0 : 1)', // 5
        '}', // 6
        '',
      ].join('\n'),
      'main.ts': [
        "import { scale } from './lib.ts'", // 1
        'const options = { factor: 3 }', // 2
        'const result = scale({ a: 2, b: 5 }, options.factor)', // 3
        "console.log('result', result)", // 4
        '',
      ].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.ts' },
        env: { NODE_OPTIONS: '--import ./register.mjs' },
        breakpoints: [
          { path: 'lib.ts', line: 2 },
          { path: 'main.ts', line: 2 },
          { path: 'lib.ts', line: 4 },
        ],
      })
      const resume = (): Promise<void> =>
        project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 1)

      // 依赖先执行：先停在它的第一句上——不是停在前面那句辅助代码上。
      const inDependency = await project.next('paused')
      assert.deepEqual([inDependency.reason, frameSummary(inDependency.frames[0])], ['breakpoint', '(anonymous)@lib.ts:2'])
      await resume()
      const inMain = await project.next('paused')
      assert.deepEqual([inMain.reason, frameSummary(inMain.frames[0])], ['breakpoint', '(anonymous)@main.ts:2'])
      await resume()
      const inFunction = await project.next('paused')
      assert.deepEqual(inFunction.frames.slice(0, 2).map(frameSummary), ['scale@lib.ts:4', '(anonymous)@main.ts:3'])
      assert.equal((await variablesOf(project, sessionId, inFunction.frames[0]!, 'local')).factor?.text, '3')
      await resume()
      assert.equal((await project.next('ended')).exitCode, 0)
      assert.match(project.launched[0]!.output(), /result 21/u)

      // 调试器自己要的那几次停顿（启动即停、脚本执行前、入口断点）都没有露给用户，也没有在同一处停两次。
      assert.deepEqual(
        project.events.flatMap((event) => (event.type === 'paused' ? [frameSummary(event.frames[0])] : [])),
        ['(anonymous)@lib.ts:2', '(anonymous)@main.ts:2', 'scale@lib.ts:4']
      )
    } finally {
      await project.dispose()
    }
  })
})
