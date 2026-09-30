import assert from 'node:assert/strict'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { describe, test } from 'bun:test'
import * as ts from 'typescript'

import {
  acquireTypeScriptLanguageService,
  freezeTypeScriptProgramWhile,
} from '../src/main/workspace/language/TypeScriptProjectHost'
import type { WorkbenchLanguageServiceFileEdit } from '../src/shared/contracts'

import {
  applyFileEdits,
  createLanguageProject,
  type LanguageProjectFixture,
} from './helpers/languageProject'

const Tsconfig = JSON.stringify({
  compilerOptions: {
    module: 'ESNext',
    moduleResolution: 'bundler',
    target: 'ESNext',
    strict: true,
    baseUrl: '.',
    paths: { '@app/*': ['./src/*'] },
  },
  include: ['src'],
})

/** 在磁盘上改名 / 移动（文件树做的那一步），并像主进程那样告诉语言服务这两个路径变了。 */
async function moveOnDisk(project: LanguageProjectFixture, previousPath: string, path: string): Promise<void> {
  await mkdir(dirname(join(project.projectRoot, path)), { recursive: true })
  await rename(join(project.projectRoot, previousPath), join(project.projectRoot, path))
  await project.services.projectFilesChanged({
    projectRoot: project.projectRoot,
    paths: [previousPath, path],
  })
}

/** 把改动写回磁盘并通知语言服务，返回改了哪些文件（排好序）。 */
async function applyToDisk(
  project: LanguageProjectFixture,
  changes: readonly WorkbenchLanguageServiceFileEdit[]
): Promise<string[]> {
  for (const change of changes)
    await project.write(change.path, applyFileEdits(await project.read(change.path), change.path, changes))
  const paths = changes.map((change) => change.path)
  await project.services.projectFilesChanged({ projectRoot: project.projectRoot, paths })
  return paths.sort()
}

async function errorsOf(project: LanguageProjectFixture, path: string): Promise<string[]> {
  const result = await project.services.getDiagnostics({ projectRoot: project.projectRoot, path })
  return result.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message)
}

void describe('imports follow a renamed or moved file', () => {
  void test('renaming a file rewrites relative and aliased imports and nothing else', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/util/math.ts': 'export const add = (a: number, b: number) => a + b\n',
      'src/main.ts': "import { add } from './util/math'\n\nexport const three = add(1, 2)\n",
      // 制表符缩进、双引号、分号：除了引号里的路径，别的一个字都不该动。
      'src/feature/view.ts':
        'import { add } from "../util/math";\n\nexport function view(): number {\n\treturn add(2, 3);\n}\n',
      'src/aliased.ts': "import { add } from '@app/util/math'\n\nexport const five = add(2, 3)\n",
      'src/unrelated.ts': 'export const unrelated = 1\n',
    })
    try {
      // 项目已经建好、认得旧文件（编辑器里开着别的文件时的样子）。
      assert.deepEqual(await errorsOf(project, 'src/main.ts'), [])

      await moveOnDisk(project, 'src/util/math.ts', 'src/util/calc.ts')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'src/util/math.ts', path: 'src/util/calc.ts' }],
      })

      assert.deepEqual(await applyToDisk(project, result.changes), [
        'src/aliased.ts',
        'src/feature/view.ts',
        'src/main.ts',
      ])
      assert.equal(
        await project.read('src/main.ts'),
        "import { add } from './util/calc'\n\nexport const three = add(1, 2)\n"
      )
      assert.equal(
        await project.read('src/feature/view.ts'),
        'import { add } from "../util/calc";\n\nexport function view(): number {\n\treturn add(2, 3);\n}\n'
      )
      assert.equal(
        await project.read('src/aliased.ts'),
        "import { add } from '@app/util/calc'\n\nexport const five = add(2, 3)\n"
      )
      for (const path of ['src/main.ts', 'src/feature/view.ts', 'src/aliased.ts'])
        assert.deepEqual(await errorsOf(project, path), [], path)
    } finally {
      await project.dispose()
    }
  })

  void test('moving a file also fixes the relative imports inside it', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/util/helper.ts': 'export const double = (value: number) => value * 2\n',
      'src/util/math.ts':
        "import { double } from './helper'\nimport { base } from '../config'\n\nexport const quad = (value: number) => double(double(value)) + base\n",
      'src/config.ts': 'export const base = 0\n',
      'src/main.ts': "import { quad } from './util/math'\n\nexport const eight = quad(2)\n",
    })
    try {
      // 项目没建过：第一次问就是这次改名。
      await moveOnDisk(project, 'src/util/math.ts', 'src/core/deep/math.ts')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'src/util/math.ts', path: 'src/core/deep/math.ts' }],
      })

      assert.deepEqual(await applyToDisk(project, result.changes), ['src/core/deep/math.ts', 'src/main.ts'])
      assert.equal(
        await project.read('src/core/deep/math.ts'),
        "import { double } from '../../util/helper'\nimport { base } from '../../config'\n\nexport const quad = (value: number) => double(double(value)) + base\n"
      )
      assert.equal(
        await project.read('src/main.ts'),
        "import { quad } from './core/deep/math'\n\nexport const eight = quad(2)\n"
      )
      assert.deepEqual(await errorsOf(project, 'src/main.ts'), [])
      assert.deepEqual(await errorsOf(project, 'src/core/deep/math.ts'), [])
    } finally {
      await project.dispose()
    }
  })

  void test('renaming a folder updates everything that points into it', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/util/helper.ts': 'export const double = (value: number) => value * 2\n',
      'src/util/math.ts': "import { double } from './helper'\n\nexport const quad = (value: number) => double(double(value))\n",
      'src/util/nested/deep.ts': "import { quad } from '../math'\n\nexport const deep = quad(1)\n",
      'src/main.ts':
        "import { quad } from './util/math'\nimport { deep } from './util/nested/deep'\nimport { double } from '@app/util/helper'\n\nexport const total = quad(2) + deep + double(1)\n",
    })
    try {
      assert.deepEqual(await errorsOf(project, 'src/main.ts'), [])

      await moveOnDisk(project, 'src/util', 'src/shared/tools')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'src/util', path: 'src/shared/tools' }],
      })

      // 目录里的文件互相之间的相对路径没变，不该有改动。
      assert.deepEqual(await applyToDisk(project, result.changes), ['src/main.ts'])
      assert.equal(
        await project.read('src/main.ts'),
        "import { quad } from './shared/tools/math'\nimport { deep } from './shared/tools/nested/deep'\nimport { double } from '@app/shared/tools/helper'\n\nexport const total = quad(2) + deep + double(1)\n"
      )
      assert.deepEqual(await errorsOf(project, 'src/main.ts'), [])
      assert.deepEqual(await errorsOf(project, 'src/shared/tools/nested/deep.ts'), [])
    } finally {
      await project.dispose()
    }
  })

  void test('files under the old folder name leave the project', async () => {
    // 没有 tsconfig 的项目不会靠重新解析配置把旧文件清出去，目录改名的通知里又只有目录自己的路径：
    // 旧位置的文件得由这次请求请出项目，否则「整项目检查」一直在查已经不存在的文件。
    const project = await createLanguageProject({
      'lib/math.ts': 'export const add = (a: number, b: number) => a + b\n',
      'main.ts': "import { add } from './lib/math'\n\nexport const three = add(1, 2)\n",
    })
    /** 整项目检查查了哪些文件：一批只查一小段时间，接着要到查完为止。 */
    const checkedPaths = async (): Promise<string[]> => {
      const paths: string[] = []
      let cursor: string | undefined
      do {
        const batch = await project.services.getProjectDiagnostics({
          projectRoot: project.projectRoot,
          anchorPaths: ['main.ts'],
          cursor,
        })
        paths.push(...batch.checkedPaths)
        cursor = batch.cursor ?? undefined
      } while (cursor)
      return paths
    }
    try {
      assert.deepEqual(await checkedPaths(), ['lib/math.ts', 'main.ts'])

      await moveOnDisk(project, 'lib', 'core')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'lib', path: 'core' }],
      })
      assert.deepEqual(await applyToDisk(project, result.changes), ['main.ts'])

      assert.deepEqual(await checkedPaths(), ['core/math.ts', 'main.ts'])
      assert.deepEqual(await errorsOf(project, 'main.ts'), [])
    } finally {
      await project.dispose()
    }
  })

  void test('an importer with unsaved changes is edited where its text is now', async () => {
    const onDisk = "import { add } from './math'\n\nexport const three = add(1, 2)\n"
    const unsaved = "// a new first line\n\nimport { add } from './math'\n\nexport const four = add(2, 2)\n"
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/math.ts': 'export const add = (a: number, b: number) => a + b\n',
      'src/main.ts': onDisk,
    })
    try {
      await moveOnDisk(project, 'src/math.ts', 'src/calc.ts')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'src/math.ts', path: 'src/calc.ts' }],
        openFiles: [
          { path: 'src/main.ts', content: unsaved },
          // 标签还没跟着挪到新路径时带来的旧位置：那里已经没有文件，不算数。
          { path: 'src/math.ts', content: 'export const stale = true\n' },
        ],
      })

      assert.deepEqual(result.changes.map((change) => change.path), ['src/main.ts'])
      assert.equal(
        applyFileEdits(unsaved, 'src/main.ts', result.changes),
        "// a new first line\n\nimport { add } from './calc'\n\nexport const four = add(2, 2)\n"
      )
    } finally {
      await project.dispose()
    }
  })

  void test('works without a tsconfig, for a file and for a folder', async () => {
    const project = await createLanguageProject({
      'lib/math.js': 'export const add = (a, b) => a + b\n',
      'lib/text.js': "export const shout = (value) => value.toUpperCase() + '!'\n",
      'main.js': "import { add } from './lib/math.js'\nimport { shout } from './lib/text.js'\n\nconsole.log(shout(String(add(1, 2))))\n",
    })
    try {
      assert.deepEqual(await errorsOf(project, 'main.js'), [])

      await moveOnDisk(project, 'lib/math.js', 'lib/calc.js')
      const renamed = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'lib/math.js', path: 'lib/calc.js' }],
      })
      assert.deepEqual(await applyToDisk(project, renamed.changes), ['main.js'])

      await moveOnDisk(project, 'lib', 'core')
      const moved = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'lib', path: 'core' }],
      })
      assert.deepEqual(await applyToDisk(project, moved.changes), ['main.js'])
      // 带扩展名的写法照旧带着扩展名。
      assert.equal(
        await project.read('main.js'),
        "import { add } from './core/calc.js'\nimport { shout } from './core/text.js'\n\nconsole.log(shout(String(add(1, 2))))\n"
      )
    } finally {
      await project.dispose()
    }
  })

  void test('tests under a second tsconfig are updated too', async () => {
    const project = await createLanguageProject({
      // 常见的布局：tsconfig.json 只管 src，另一份配置连测试一起管。
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ESNext', strict: true },
        include: ['src'],
      }),
      'tsconfig.eslint.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'tests'] }),
      'src/math.ts': 'export const add = (a: number, b: number) => a + b\n',
      'src/main.ts': "import { add } from './math'\n\nexport const three = add(1, 2)\n",
      'tests/math.test.ts': "import { add } from '../src/math'\n\nexport const check = add(1, 2) === 3\n",
    })
    try {
      // 只有 src 的项目建着；测试文件一个都没打开过。
      assert.deepEqual(await errorsOf(project, 'src/main.ts'), [])
      assert.equal(project.services.describeMemory().projects, 1)

      await moveOnDisk(project, 'src/math.ts', 'src/calc.ts')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'src/math.ts', path: 'src/calc.ts' }],
      })

      assert.deepEqual(await applyToDisk(project, result.changes), ['src/main.ts', 'tests/math.test.ts'])
      assert.equal(
        await project.read('tests/math.test.ts'),
        "import { add } from '../src/calc'\n\nexport const check = add(1, 2) === 3\n"
      )
      // 两个项目都认得 src/main.ts，它的改动只该有一份。
      assert.equal(result.changes.find((change) => change.path === 'src/main.ts')?.edits.length, 1)
    } finally {
      await project.dispose()
    }
  })

  void test('another package that reaches the file through an alias is updated when its project is up', async () => {
    const packageConfig = (paths?: Record<string, string[]>): string =>
      JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ESNext',
          strict: true,
          ...(paths ? { baseUrl: '.', paths } : {}),
        },
        include: ['src'],
      })
    const project = await createLanguageProject({
      'packages/core/tsconfig.json': packageConfig(),
      'packages/core/src/math.ts': 'export const add = (a: number, b: number) => a + b\n',
      'packages/core/src/index.ts': "export { add } from './math'\n",
      'packages/app/tsconfig.json': packageConfig({ '@core/*': ['../core/src/*'] }),
      'packages/app/src/main.ts': "import { add } from '@core/math'\n\nexport const three = add(1, 2)\n",
    })
    try {
      // 两个包的项目都建着（各开着一个文件）。
      assert.deepEqual(await errorsOf(project, 'packages/core/src/index.ts'), [])
      assert.deepEqual(await errorsOf(project, 'packages/app/src/main.ts'), [])
      assert.equal(project.services.describeMemory().projects, 2)

      await moveOnDisk(project, 'packages/core/src/math.ts', 'packages/core/src/calc.ts')
      // 引用方的项目在改名之后、问改动之前又算过一遍（编辑器里接着打了字）：它已经不认得旧文件，也还不认得
      // 新文件。别名不像相对路径能照着旧路径推出新路径，新位置的文件得在它的程序里才改得过去。
      const unsaved = "import { add } from '@core/math'\n\nexport const three = add(1, 2) // edited\n"
      const stale = await project.services.getDiagnostics({
        projectRoot: project.projectRoot,
        path: 'packages/app/src/main.ts',
        content: unsaved,
      })
      assert.match(stale.diagnostics.map((diagnostic) => diagnostic.message).join('\n'), /@core\/math/u)

      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'packages/core/src/math.ts', path: 'packages/core/src/calc.ts' }],
        openFiles: [{ path: 'packages/app/src/main.ts', content: unsaved }],
      })

      assert.deepEqual(result.changes.map((change) => change.path).sort(), [
        'packages/app/src/main.ts',
        'packages/core/src/index.ts',
      ])
      assert.equal(
        applyFileEdits(unsaved, 'packages/app/src/main.ts', result.changes),
        "import { add } from '@core/calc'\n\nexport const three = add(1, 2) // edited\n"
      )
    } finally {
      await project.dispose()
    }
  })

  void test('several entries moved at once are handled in one request', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': "import { a } from './a'\n\nexport const b = a + 1\n",
      'src/main.ts': "import { a } from './a'\nimport { b } from './b'\n\nexport const total = a + b\n",
    })
    try {
      await moveOnDisk(project, 'src/a.ts', 'src/lib/a.ts')
      await moveOnDisk(project, 'src/b.ts', 'src/lib/b.ts')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [
          { previousPath: 'src/a.ts', path: 'src/lib/a.ts' },
          { previousPath: 'src/b.ts', path: 'src/lib/b.ts' },
        ],
      })

      // a 与 b 一起挪进同一个目录，b 里的 './a' 仍然对。
      assert.deepEqual(await applyToDisk(project, result.changes), ['src/main.ts'])
      assert.equal(
        await project.read('src/main.ts'),
        "import { a } from './lib/a'\nimport { b } from './lib/b'\n\nexport const total = a + b\n"
      )
      assert.deepEqual(await errorsOf(project, 'src/main.ts'), [])
      assert.deepEqual(await errorsOf(project, 'src/lib/b.ts'), [])
    } finally {
      await project.dispose()
    }
  })

  void test('entries that are not JavaScript or TypeScript never start a project', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/main.ts': "import data from './data.json'\n\nexport const value = data\n",
      'src/data.json': '{}\n',
      'docs/guide/intro.md': '# intro\n',
      'node_modules/pkg/index.js': 'module.exports = {}\n',
    })
    try {
      await moveOnDisk(project, 'src/data.json', 'src/values.json')
      await moveOnDisk(project, 'docs/guide', 'docs/manual')
      await moveOnDisk(project, 'node_modules/pkg', 'node_modules/renamed')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [
          { previousPath: 'src/data.json', path: 'src/values.json' },
          { previousPath: 'docs/guide', path: 'docs/manual' },
          { previousPath: 'node_modules/pkg', path: 'node_modules/renamed' },
        ],
      })
      assert.deepEqual(result.changes, [])
      assert.equal(project.services.describeMemory().projects, 0)
    } finally {
      await project.dispose()
    }
  })

  void test('the program is only held still while the edits are computed', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/main.ts': 'export const value = 1\n',
    })
    try {
      const fileName = join(project.projectRoot, 'src/main.ts')
      const acquire = (content: string) =>
        acquireTypeScriptLanguageService(project.projectRoot, fileName, [fileName], new Map([[fileName, content]]))
      const textInProgram = (service: ReturnType<typeof acquire>['service']): string | undefined =>
        service.getProgram()?.getSourceFile(fileName)?.text

      const { service } = acquire('export const value = 1\n')
      assert.equal(textInProgram(service), 'export const value = 1\n')

      freezeTypeScriptProgramWhile(service, () => {
        // 进来的第一次照常核对，之后不再核对：TypeScript 算改名的改动时要取几十万次程序，每次都核对就算不完。
        assert.equal(textInProgram(service), 'export const value = 1\n')
        acquire('export const value = 2\n')
        assert.equal(textInProgram(service), 'export const value = 1\n')
      })

      // 出来之后一切照旧：宿主里的正文变了，下一次取程序就跟上。
      assert.equal(textInProgram(service), 'export const value = 2\n')
      acquire('export const value = 3\n')
      assert.equal(textInProgram(service), 'export const value = 3\n')
    } finally {
      await project.dispose()
    }
  })

  void test('computing the edits does not re-check the program or read declaration maps for every file', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': Tsconfig,
      'src/math.ts': 'export const add = (a: number, b: number) => a + b\n',
      'src/main.ts': "import { add } from './math'\n\nexport const three = add(1, 2)\n",
    })
    const fileExists = ts.sys.fileExists
    try {
      assert.deepEqual(await errorsOf(project, 'src/main.ts'), [])
      // 项目里的文件表就是宿主交给 TypeScript 的根文件清单：TypeScript 每核对一次程序就来取一次。
      const fileName = join(project.projectRoot, 'src/main.ts')
      const { files } = acquireTypeScriptLanguageService(project.projectRoot, fileName, [fileName], new Map())
      const keys = files.keys.bind(files)
      let checks = 0
      files.keys = () => {
        checks += 1
        return keys()
      }
      const declarationMapLookups: string[] = []
      ts.sys.fileExists = (path) => {
        if (path.endsWith('.d.ts.map')) declarationMapLookups.push(path)
        return fileExists(path)
      }

      await moveOnDisk(project, 'src/math.ts', 'src/calc.ts')
      const result = await project.services.getFileRenameEdits({
        projectRoot: project.projectRoot,
        renames: [{ previousPath: 'src/math.ts', path: 'src/calc.ts' }],
      })
      assert.deepEqual(result.changes.map((change) => change.path), ['src/main.ts'])
      // 不冻结的话，程序里每个声明文件（光标准库就上百个）、每条 import 都要核对一次：带着依赖的真实项目里
      // 是几十万次，一次改名算十几分钟。
      assert.ok(checks <= 8, `the program was re-checked ${checks} times`)
      // 声明文件的映射也不去找：不然每个声明文件都要查一次盘，有映射的还要读进来解码。
      assert.deepEqual(declarationMapLookups, [])
    } finally {
      ts.sys.fileExists = fileExists
      await project.dispose()
    }
  })

  void test('a path outside the project is refused', async () => {
    const project = await createLanguageProject({ 'src/main.ts': 'export const value = 1\n' })
    try {
      await assert.rejects(
        project.services.getFileRenameEdits({
          projectRoot: project.projectRoot,
          renames: [{ previousPath: 'src/main.ts', path: '../outside.ts' }],
        })
      )
    } finally {
      await project.dispose()
    }
  })
})
