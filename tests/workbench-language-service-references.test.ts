import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { type WorkbenchLanguageServiceLocation } from '../src/shared/contracts/workbench'

import { createLanguageProject, positionOf, StrictTsconfig } from './helpers/languageProject'

/** 按文件、行、列排好：语言服务给的先后不作数。 */
function inOrder(locations: readonly WorkbenchLanguageServiceLocation[]): WorkbenchLanguageServiceLocation[] {
  return [...locations].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column
  )
}

void describe('find references', () => {
  void test('lists every use across files with the line it is on', async () => {
    const math = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'
    const main = "import { add } from './math'\n\nexport const three = add(1, 2)\n"
    const view =
      "import { add } from '../math'\n\nexport function view(): number {\n\treturn add(2, 3) + add(4, 5)\n}\n"
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/math.ts': math,
      'src/main.ts': main,
      'src/feature/view.ts': view,
      'src/unrelated.ts': 'export const add = 1\n',
    })
    try {
      const result = await project.services.getReferences({
        projectRoot: project.projectRoot,
        path: 'src/math.ts',
        position: positionOf(math, 'add'),
      })

      assert.deepEqual(
        inOrder(result.locations).map((location) => [
          location.path,
          location.line,
          location.column,
          location.preview,
        ]),
        [
          ['src/feature/view.ts', 1, 10, "import { add } from '../math'"],
          ['src/feature/view.ts', 4, 9, 'return add(2, 3) + add(4, 5)'],
          ['src/feature/view.ts', 4, 21, 'return add(2, 3) + add(4, 5)'],
          ['src/main.ts', 1, 10, "import { add } from './math'"],
          ['src/main.ts', 3, 22, 'export const three = add(1, 2)'],
          ['src/math.ts', 1, 17, 'export function add(a: number, b: number): number {'],
        ]
      )
    } finally {
      await project.dispose()
    }
  })

  void test('positions follow the unsaved text of the request file and of other open files', async () => {
    const math = 'export const add = (a: number, b: number) => a + b\n'
    const onDisk = "import { add } from './math'\n\nexport const three = add(1, 2)\n"
    const unsavedMain = "// edited\n\nimport { add } from './math'\n\nexport const four = add(2, 2)\n"
    const unsavedMath = '// moved down\n\nexport const add = (a: number, b: number) => a + b\n'
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/math.ts': math,
      'src/main.ts': onDisk,
    })
    try {
      const result = await project.services.getReferences({
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content: unsavedMain,
        openFiles: [{ path: 'src/math.ts', content: unsavedMath }],
        position: positionOf(unsavedMain, 'add', 2),
      })

      assert.deepEqual(
        inOrder(result.locations).map((location) => [location.path, location.line, location.preview]),
        [
          ['src/main.ts', 3, "import { add } from './math'"],
          ['src/main.ts', 5, 'export const four = add(2, 2)'],
          ['src/math.ts', 3, 'export const add = (a: number, b: number) => a + b'],
        ]
      )
    } finally {
      await project.dispose()
    }
  })

  void test('a use in a file the project only reaches through an import is placed by that file', async () => {
    // 没有 tsconfig 的项目：建好之后才出现的文件不是根文件，靠 import 进到程序里。它的行列以前照着请求文件的
    // 正文算，落在请求文件长度以外就被丢掉，落在以内就是错的行。
    const math = 'export const add = (a: number, b: number) => a + b\n'
    const late = `${'// padding\n'.repeat(40)}import { add } from './math'\n\nexport const late = add(20, 22)\n`
    const project = await createLanguageProject({
      'math.ts': math,
      'main.ts': "import { add } from './math'\n\nexport const three = add(1, 2)\n",
    })
    try {
      await project.services.getDiagnostics({ projectRoot: project.projectRoot, path: 'main.ts' })
      await project.write('late.ts', late)
      await project.write('main.ts', "import { late } from './late'\n\nexport const value = late\n")
      await project.services.projectFilesChanged({
        projectRoot: project.projectRoot,
        paths: ['late.ts', 'main.ts'],
      })
      await project.services.getDiagnostics({ projectRoot: project.projectRoot, path: 'main.ts' })

      const result = await project.services.getReferences({
        projectRoot: project.projectRoot,
        path: 'math.ts',
        position: positionOf(math, 'add'),
      })
      assert.deepEqual(
        inOrder(result.locations).map((location) => [location.path, location.line, location.preview]),
        [
          ['late.ts', 41, "import { add } from './math'"],
          ['late.ts', 43, 'export const late = add(20, 22)'],
          ['math.ts', 1, 'export const add = (a: number, b: number) => a + b'],
        ]
      )
    } finally {
      await project.dispose()
    }
  })

  void test('very long lines are cut in the preview', async () => {
    const values = Array.from({ length: 80 }, (_, index) => `value + ${index}`).join(', ')
    const content = `export const value = 1\nexport const list = [${values}]\n`
    const project = await createLanguageProject({ 'tsconfig.json': StrictTsconfig, 'src/main.ts': content })
    try {
      const result = await project.services.getReferences({
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        position: positionOf(content, 'value'),
      })
      assert.equal(result.locations.length, 81)
      for (const location of result.locations) assert.ok((location.preview ?? '').length <= 200)
      assert.equal(result.locations[1]?.preview?.startsWith('export const list = [value + 0'), true)
    } finally {
      await project.dispose()
    }
  })

  void test('files without a language service that knows references give none', async () => {
    const project = await createLanguageProject({ 'notes.txt': 'add add add\n', 'style.css': '.add { color: red }\n' })
    try {
      for (const path of ['notes.txt', 'style.css']) {
        const result = await project.services.getReferences({
          projectRoot: project.projectRoot,
          path,
          position: { line: 1, column: 2 },
        })
        assert.deepEqual(result.locations, [], path)
      }
    } finally {
      await project.dispose()
    }
  })
})
