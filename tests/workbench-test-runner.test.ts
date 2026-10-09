import assert from 'node:assert/strict'

import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import { quoteWorkbenchShellArgument } from '../src/renderer/src/models/commands/workbenchShellQuote'
import {
  buildWorkbenchTestDebugTarget,
  buildWorkbenchTestRunCommand,
  detectWorkbenchTestRunner,
  isWorkbenchJavaScriptTestFilePath,
  listWorkbenchTestRunnerLookupDirectories,
  listWorkbenchTestRunnerProbePaths,
  pickWorkbenchTestRunner,
  readWorkbenchTestPackageManager,
  readWorkbenchTestRunnerEvidence,
  readWorkbenchTestRunnerImport,
  type WorkbenchTestRunnerProject,
} from '../src/renderer/src/models/commands/workbenchTestRunner'
import {
  collectWorkbenchTestBlocks,
  findWorkbenchTestBlockAt,
} from '../src/renderer/src/models/editor/workbenchTestBlocks'

function parse(source: string, options: { typescript?: boolean; jsx?: boolean } = {}): EditorState {
  const state = EditorState.create({ doc: source, extensions: [javascript(options)] })
  assert.ok(ensureSyntaxTree(state, source.length, 5_000), 'the document should parse')
  return state.update({}).state
}

function blocksOf(source: string, options?: { typescript?: boolean; jsx?: boolean }) {
  const state = parse(source, options)
  return collectWorkbenchTestBlocks(state, 0, source.length).map((block) => ({
    kind: block.kind,
    title: block.title,
    pattern: block.pattern,
    line: state.doc.lineAt(block.from).number,
  }))
}

void describe('test blocks in a test file', () => {
  void test('finds describe, it and test calls with the full name of each', () => {
    const blocks = blocksOf(
      [
        "import { describe, it, test } from 'vitest'",
        '',
        "describe('math (basic)', () => {",
        "  it('adds 1 + 2 [ok]', () => {",
        '    expect(1 + 2).toBe(3)',
        '  })',
        "  describe('nested', function () {",
        '    test("works \\"quoted\\" and $pecial", async () => {})',
        '  })',
        '})',
        '',
        "test('top level', () => {})",
      ].join('\n')
    )

    assert.deepEqual(blocks, [
      { kind: 'suite', title: 'math (basic)', pattern: '^math \\(basic\\) ', line: 3 },
      {
        kind: 'test',
        title: 'adds 1 + 2 [ok]',
        pattern: '^math \\(basic\\) (?:> )?adds 1 \\+ 2 \\[ok\\]$',
        line: 4,
      },
      {
        kind: 'suite',
        title: 'nested',
        pattern: '^math \\(basic\\) (?:> )?nested ',
        line: 7,
      },
      {
        kind: 'test',
        title: 'works "quoted" and $pecial',
        pattern: '^math \\(basic\\) (?:> )?nested (?:> )?works "quoted" and \\$pecial$',
        line: 8,
      },
      { kind: 'test', title: 'top level', pattern: '^top level$', line: 12 },
    ])
    // 正则要真的能匹配两个运行器各自拼出来的全名。
    const nested = new RegExp(blocks[3]!.pattern, 'u')
    assert.ok(nested.test('math (basic) nested works "quoted" and $pecial'))
    assert.ok(nested.test('math (basic) > nested > works "quoted" and $pecial'))
    assert.equal(nested.test('math (basic) nested works "quoted" and $pecial too'), false)
    const suite = new RegExp(blocks[0]!.pattern, 'u')
    assert.ok(suite.test('math (basic) adds 1 + 2 [ok]'))
    assert.ok(suite.test('math (basic) > nested > works'))
    assert.equal(suite.test('math (basic)ally different adds'), false)
  })

  void test('understands modifiers, parameterized titles and titles that are not literals', () => {
    const blocks = blocksOf(
      [
        "describe.skip('suite', () => {",
        "  it.only('focused', () => {})",
        "  test.each([[1, 2]])('adds %i + %i = %%', (a, b) => {})",
        '  test.concurrent.each`',
        '    a | b',
        '    ${1} | ${2}',
        "  `('table $a + $b.c', () => {})",
        "  test.for([1])('for %s', () => {})",
        "  test.skipIf(process.env.CI)('not in $CI', () => {})",
        '  it(`template ${name} here`, () => {})',
        '  it(`plain template`, () => {})',
        '  describe(Widget.name, () => {',
        '    it(title, () => {})',
        '  })',
        "  it.todo('later')",
        "  xit('disabled', () => {})",
        "  fdescribe('focused suite', () => {})",
        '})',
      ].join('\n'),
      { typescript: true }
    )

    assert.deepEqual(
      blocks.map(({ kind, title, pattern }) => [kind, title, pattern]),
      [
        ['suite', 'suite', '^suite '],
        ['test', 'focused', '^suite (?:> )?focused$'],
        ['test', 'adds %i + %i = %%', '^suite (?:> )?adds .* \\+ .* = %$'],
        ['test', 'table $a + $b.c', '^suite (?:> )?table .* \\+ .*$'],
        ['test', 'for %s', '^suite (?:> )?for .*$'],
        // 不带参数表的标题里，`$CI` 就是字面上的字。
        ['test', 'not in $CI', '^suite (?:> )?not in \\$CI$'],
        ['test', 'template ${name} here', '^suite (?:> )?template .* here$'],
        ['test', 'plain template', '^suite (?:> )?plain template$'],
        ['suite', 'Widget.name', '^suite (?:> )?.* '],
        ['test', 'title', '^suite (?:> )?.* (?:> )?.*$'],
        ['test', 'later', '^suite (?:> )?later$'],
        ['test', 'disabled', '^suite (?:> )?disabled$'],
        ['suite', 'focused suite', '^suite (?:> )?focused suite '],
      ]
    )
  })

  void test('ignores calls that only look like tests', () => {
    assert.deepEqual(
      blocksOf(
        [
          'const alias = describe',
          "runner.describe('member of something else', () => {})",
          "this.it('method', () => {})",
          'const myTest = test.extend({ page: async ({}, use) => use(1) })',
          "test.step('not a declaration', async () => {})",
          "describe['only']('computed member', () => {})",
          'it()',
          "describe2('other name', () => {})",
          "// it('in a comment', () => {})",
          'const text = "it(\'in a string\', () => {})"',
          "expect(test('x')).toBe(1)",
        ].join('\n')
      ).map((block) => block.title),
      // 最后一行的 test(…) 是一次真的调用，语法上分不出它是不是测试：算。
      ['x']
    )
  })

  void test('reads escapes in titles and keeps long titles short', () => {
    const [unicode, long] = blocksOf(
      [
        "it('tab\\there \\u4e2d\\x41 \\'q\\' \\u{1F600}', () => {})",
        `it('${'x'.repeat(200)}', () => {})`,
      ].join('\n')
    )
    assert.equal(unicode?.title, "tab here 中A 'q' 😀")
    assert.equal(unicode?.pattern, "^tab\there 中A 'q' 😀$")
    assert.equal(long?.title.length, 80)
    assert.ok(long?.title.endsWith('…'))
    assert.equal(long?.pattern, `^${'x'.repeat(200)}$`)
  })

  void test('looks only at the requested range but still knows the enclosing suites', () => {
    const source = [
      "describe('outer', () => {",
      "  it('first', () => {})",
      '',
      '',
      "  describe('inner', () => {",
      "    it('second', () => {",
      '      const marker = 1',
      '    })',
      '  })',
      '})',
    ].join('\n')
    const state = parse(source)
    const markerAt = source.indexOf('const marker')

    // 只看 `second` 那几行：外层两个 describe 的开头都在范围之上。
    const visible = collectWorkbenchTestBlocks(state, source.indexOf("it('second'"), markerAt)
    assert.deepEqual(
      visible.map((block) => block.title),
      ['outer', 'inner', 'second']
    )
    assert.equal(visible.at(-1)?.pattern, '^outer (?:> )?inner (?:> )?second$')

    assert.equal(findWorkbenchTestBlockAt(state, markerAt)?.title, 'second')
    assert.equal(findWorkbenchTestBlockAt(state, source.indexOf("describe('inner'") + 3)?.title, 'inner')
    assert.equal(findWorkbenchTestBlockAt(state, source.indexOf('\n\n') + 1)?.title, 'outer')
    assert.equal(findWorkbenchTestBlockAt(parse("const a = 1\nit('x', () => {})"), 3), null)
  })

  void test('finds nothing before the syntax tree is there', () => {
    const state = EditorState.create({ doc: "it('x', () => {})" })
    assert.deepEqual(collectWorkbenchTestBlocks(state, 0, state.doc.length), [])
  })
})

void describe('test runner of a project', () => {
  void test('knows which files are JavaScript or TypeScript tests', () => {
    for (const path of [
      'src/math.test.ts',
      'src/widget.spec.tsx',
      'a/b/c.test.mjs',
      'lib/legacy.spec.cjs',
      'src/__tests__/helper.js',
      '__tests__/root.ts',
      'packages\\core\\x.test.mts',
    ])
      assert.equal(isWorkbenchJavaScriptTestFilePath(path), true, path)
    for (const path of [
      'src/math.ts',
      'tests/world.test.vel',
      'src/test.py',
      'src/contest.ts',
      'docs/testing.test.md',
      'src/__tests__/fixture.json',
      'src/my__tests__/a.ts',
      null,
    ])
      assert.equal(isWorkbenchJavaScriptTestFilePath(path), false, String(path))
  })

  void test('looks from the folder of the test file up to the project root', () => {
    assert.deepEqual(listWorkbenchTestRunnerLookupDirectories('packages/core/src/math.test.ts'), [
      'packages/core/src',
      'packages/core',
      'packages',
      '',
    ])
    assert.deepEqual(listWorkbenchTestRunnerLookupDirectories('math.test.ts'), [''])
    const probes = listWorkbenchTestRunnerProbePaths('packages/core')
    assert.ok(probes.includes('packages/core/package.json'))
    assert.ok(probes.includes('packages/core/vitest.config.mts'))
    assert.ok(probes.includes('packages/core/jest.config.cjs'))
    assert.ok(probes.includes('packages/core/pnpm-lock.yaml'))
    assert.ok(listWorkbenchTestRunnerProbePaths('').includes('package.json'))
    // 一次问主进程最多 64 个路径。
    assert.ok(probes.length <= 64)
  })

  void test('recognizes Vitest and Jest from config files, dependencies and scripts', () => {
    const manifest = (value: object): string => JSON.stringify(value)

    assert.deepEqual(readWorkbenchTestRunnerEvidence(['vitest.config.ts'], null), { vitest: 3 })
    assert.deepEqual(readWorkbenchTestRunnerEvidence(['jest.config.js', 'package.json'], '{}'), {
      jest: 3,
    })
    assert.deepEqual(
      readWorkbenchTestRunnerEvidence([], manifest({ jest: { testEnvironment: 'node' } })),
      { jest: 3 }
    )
    assert.deepEqual(
      readWorkbenchTestRunnerEvidence([], manifest({ devDependencies: { vitest: '^3.0.0' } })),
      { vitest: 2 }
    )
    assert.deepEqual(
      readWorkbenchTestRunnerEvidence([], manifest({ dependencies: { 'ts-jest': '29' } })),
      { jest: 2 }
    )
    assert.deepEqual(
      readWorkbenchTestRunnerEvidence(
        [],
        manifest({ scripts: { test: 'vitest run --coverage', e2e: 'node e2e.js' } })
      ),
      { vitest: 1 }
    )
    assert.deepEqual(
      readWorkbenchTestRunnerEvidence([], manifest({ scripts: { test: 'NODE_ENV=test jest' } })),
      { jest: 1 }
    )
    // 名字里带着 jest / vitest 的别的东西不算；Bun 自带的测试运行器也不算。
    assert.deepEqual(
      readWorkbenchTestRunnerEvidence(
        ['bun.lock'],
        manifest({
          devDependencies: { 'eslint-plugin-jest': '1', 'jest-extended': '1' },
          scripts: { test: 'bun test', lint: 'eslint --plugin my-vitest-rules .' },
        })
      ),
      {}
    )
    assert.deepEqual(readWorkbenchTestRunnerEvidence(['package.json'], '{ not json'), {})
    assert.deepEqual(readWorkbenchTestRunnerEvidence([], '[]'), {})
  })

  void test('chooses between two runners by what the test file imports, then by the stronger sign', () => {
    assert.equal(pickWorkbenchTestRunner({}), null)
    assert.equal(pickWorkbenchTestRunner({ jest: 1 }), 'jest')
    assert.equal(pickWorkbenchTestRunner({ vitest: 1, jest: 3 }), 'jest')
    assert.equal(pickWorkbenchTestRunner({ vitest: 2, jest: 2 }), 'vitest')
    assert.equal(pickWorkbenchTestRunner({ vitest: 3, jest: 1 }, 'jest'), 'jest')
    // 文件引了一个项目里没有依据的运行器：不听它的。
    assert.equal(pickWorkbenchTestRunner({ jest: 2 }, 'vitest'), 'jest')

    assert.equal(readWorkbenchTestRunnerImport("import { it } from 'vitest'\n"), 'vitest')
    assert.equal(readWorkbenchTestRunnerImport('const { it } = require("vitest")'), 'vitest')
    assert.equal(
      readWorkbenchTestRunnerImport("import { jest, expect } from '@jest/globals'"),
      'jest'
    )
    assert.equal(readWorkbenchTestRunnerImport("import x from './vitest-helpers'"), null)
  })

  void test('reads the package manager from the manifest, then from the lock file', () => {
    assert.equal(
      readWorkbenchTestPackageManager(['yarn.lock'], '{"packageManager":"pnpm@9.12.0"}'),
      'pnpm'
    )
    assert.equal(readWorkbenchTestPackageManager(['bun.lock'], '{"packageManager":"deno@2"}'), 'bun')
    assert.equal(readWorkbenchTestPackageManager(['yarn.lock'], null), 'yarn')
    assert.equal(readWorkbenchTestPackageManager(['package-lock.json'], '{}'), 'npm')
    assert.equal(readWorkbenchTestPackageManager(['package.json'], '{}'), null)
  })

  const project = (
    runner: WorkbenchTestRunnerProject['runner'],
    packageManager: WorkbenchTestRunnerProject['packageManager'],
    packageDir = ''
  ): WorkbenchTestRunnerProject => ({ runner, packageManager, packageDir })

  void test('builds a one-shot command for the runner and the package manager', () => {
    const pattern = '^math \\(basic\\) (?:> )?adds 1 \\+ 2$'

    assert.equal(
      buildWorkbenchTestRunCommand({
        project: project('vitest', 'npm'),
        filePath: 'src/math.test.ts',
        pattern,
        windows: false,
      }),
      "npx --no-install vitest run src/math.test.ts -t '^math \\(basic\\) (?:> )?adds 1 \\+ 2$'"
    )
    assert.equal(
      buildWorkbenchTestRunCommand({
        project: project('jest', 'pnpm', 'packages/core'),
        filePath: 'packages/core/src/my file.test.ts',
        pattern: "^it's here$",
        windows: false,
      }),
      "pnpm exec jest --runTestsByPath 'src/my file.test.ts' -t '^it'\\''s here$'"
    )
    // 整个文件：不带 -t。
    assert.equal(
      buildWorkbenchTestRunCommand({
        project: project('vitest', 'bun'),
        filePath: 'math.test.ts',
        windows: false,
      }),
      'bunx --no-install vitest run math.test.ts'
    )
    assert.equal(
      buildWorkbenchTestRunCommand({
        project: project('jest', 'yarn'),
        filePath: 'src/math.test.js',
        windows: false,
      }),
      'yarn run jest --runTestsByPath src/math.test.js'
    )
    // Windows 的 cmd：双引号，里面的 " 和 % 换成正则里的任意字符。
    assert.equal(
      buildWorkbenchTestRunCommand({
        project: project('vitest', 'npm'),
        filePath: 'src/math.test.ts',
        pattern: '^says "hi" 100%$',
        windows: true,
      }),
      'npx --no-install vitest run src/math.test.ts -t "^says .hi. 100.$"'
    )
    assert.equal(quoteWorkbenchShellArgument('plain-path_1/a.b:c=d@e', false), 'plain-path_1/a.b:c=d@e')
    assert.equal(quoteWorkbenchShellArgument('', false), "''")
    assert.equal(quoteWorkbenchShellArgument('$(rm -rf ~); `x`', false), "'$(rm -rf ~); `x`'")
  })

  void test('starts the runner so that the test runs in one process the debugger can attach to', () => {
    // Vitest 自己认检查器开关（主进程接在命令末尾）：关掉文件并行，测试就在那个带检查器的进程里跑。
    assert.deepEqual(
      buildWorkbenchTestDebugTarget({
        project: project('vitest', 'pnpm', 'packages/core'),
        filePath: 'packages/core/src/math.test.ts',
        pattern: '^math (?:> )?adds$',
        windows: false,
      }),
      {
        kind: 'inspect-command',
        command:
          "pnpm exec vitest run src/math.test.ts -t '^math (?:> )?adds$' --no-file-parallelism --testTimeout=0",
      }
    )
    // Jest 不认：由 node 带着检查器起它的可执行入口，--runInBand 让测试留在这个进程里。包管理器不参与。
    assert.deepEqual(
      buildWorkbenchTestDebugTarget({
        project: project('jest', 'yarn'),
        filePath: 'src/my file.test.js',
        pattern: "^it's here$",
        windows: false,
      }),
      {
        kind: 'node-package-bin',
        packageName: 'jest',
        args: "--runInBand --runTestsByPath 'src/my file.test.js' -t '^it'\\''s here$' --testTimeout=100000000",
      }
    )
    // 整个文件：不带 -t。
    assert.deepEqual(
      buildWorkbenchTestDebugTarget({
        project: project('jest', 'npm'),
        filePath: 'math.test.js',
        windows: false,
      }),
      {
        kind: 'node-package-bin',
        packageName: 'jest',
        args: '--runInBand --runTestsByPath math.test.js --testTimeout=100000000',
      }
    )
  })
})

/** 一个假的项目：路径 → 文件内容。 */
function probeOf(files: Record<string, string>): {
  findExistingFiles: (paths: string[]) => Promise<string[]>
  readFile: (path: string) => Promise<Nullable<string>>
  asked: string[][]
} {
  const asked: string[][] = []
  return {
    asked,
    findExistingFiles: async (paths) => {
      asked.push(paths)
      return paths.filter((path) => Object.hasOwn(files, path))
    },
    readFile: async (path) => files[path] ?? null,
  }
}

void describe('finding the test runner for a file', () => {
  void test('uses the nearest package that names a runner and the package manager of the project', async () => {
    const probe = probeOf({
      'package.json': JSON.stringify({ private: true, devDependencies: { jest: '^30.0.0' } }),
      'pnpm-lock.yaml': '',
      'packages/core/package.json': JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }),
      'packages/plain/package.json': JSON.stringify({ name: 'plain' }),
    })

    assert.deepEqual(await detectWorkbenchTestRunner('packages/core/src/deep/math.test.ts', probe), {
      evidence: { vitest: 2 },
      packageDir: 'packages/core',
      packageManager: 'pnpm',
    })
    // 自己的 package.json 没提运行器：往上找到根的 Jest，在根目录跑。
    assert.deepEqual(await detectWorkbenchTestRunner('packages/plain/a.test.js', probe), {
      evidence: { jest: 2 },
      packageDir: '',
      packageManager: 'pnpm',
    })
    // 一层目录只问一次文件系统，每次不超过主进程一次肯查的数量。
    assert.ok(probe.asked.every((paths) => paths.length <= 64))
    assert.deepEqual(
      probe.asked.slice(0, 4).map((paths) => paths[0]),
      [
        'packages/core/src/deep/package.json',
        'packages/core/src/package.json',
        'packages/core/package.json',
        'packages/package.json',
      ]
    )
  })

  void test('stops climbing once the runner and the package manager are known', async () => {
    const probe = probeOf({
      'app/package.json': JSON.stringify({ packageManager: 'yarn@4.5.0', scripts: { test: 'vitest' } }),
      'app/vitest.config.ts': '',
      'package.json': JSON.stringify({ devDependencies: { jest: '1' } }),
    })
    assert.deepEqual(await detectWorkbenchTestRunner('app/src/a.spec.tsx', probe), {
      evidence: { vitest: 3 },
      packageDir: 'app',
      packageManager: 'yarn',
    })
    assert.equal(probe.asked.length, 2)
  })

  void test('keeps both runners when a package has both, and falls back to npm', async () => {
    const probe = probeOf({
      'package.json': JSON.stringify({ devDependencies: { vitest: '3', jest: '30' } }),
    })
    assert.deepEqual(await detectWorkbenchTestRunner('src/a.test.ts', probe), {
      evidence: { vitest: 2, jest: 2 },
      packageDir: '',
      packageManager: 'npm',
    })
  })

  void test('finds nothing in a project without Vitest or Jest', async () => {
    assert.equal(
      await detectWorkbenchTestRunner(
        'tests/a.test.ts',
        probeOf({ 'package.json': JSON.stringify({ scripts: { test: 'bun test' } }), 'bun.lock': '' })
      ),
      null
    )
    assert.equal(await detectWorkbenchTestRunner('a.test.ts', probeOf({})), null)
  })
})
