import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { WorkbenchLanguageServiceCallHierarchyResult } from '../src/shared/contracts'

import { createLanguageProject, positionOf, StrictTsconfig } from './helpers/languageProject'

const MathFile = [
  'export function add(a: number, b: number): number {',
  '  return a + b',
  '}',
  '',
  'export function sum(values: number[]): number {',
  '  return values.reduce((total, value) => add(total, value), 0)',
  '}',
  '',
].join('\n')

const ShapesFile = [
  "import { add, sum } from './math'",
  '',
  'export class Circle {',
  '  constructor(private readonly radius: number) {}',
  '  area(): number {',
  '    return add(this.radius, this.radius) + add(1, 2)',
  '  }',
  '  total(): number {',
  '    return sum([this.area(), this.area()])',
  '  }',
  '}',
  '',
  'export const helper = (): number => new Circle(1).total()',
  '',
  'console.log(helper())',
  '',
].join('\n')

const Files = { 'tsconfig.json': StrictTsconfig, 'src/math.ts': MathFile, 'src/shapes.ts': ShapesFile }

/** 每个调用方（被调用方）一行：`外层.名字 [种类] 文件:行 <- 调用处的行:列…`。 */
function describeCalls(result: WorkbenchLanguageServiceCallHierarchyResult): string[] {
  return result.calls.map((call) => {
    const name = call.item.containerName ? `${call.item.containerName}.${call.item.name}` : call.item.name
    const sites = call.sites.map((site) => `${site.path}:${site.line}:${site.column}`).join(' ')
    return `${name} [${call.item.kind}] ${call.item.path}:${call.item.line} <- ${sites}`
  })
}

void describe('call hierarchy', () => {
  void test('incoming: who calls the function, across files, with every call site', async () => {
    const project = await createLanguageProject(Files)
    try {
      const result = await project.services.getCallHierarchy({
        projectRoot: project.projectRoot,
        path: 'src/math.ts',
        position: positionOf(MathFile, 'add'),
        direction: 'incoming',
      })
      assert.deepEqual(result.item, {
        name: 'add',
        kind: 'function',
        containerName: undefined,
        path: 'src/math.ts',
        line: 1,
        column: 17,
      })
      assert.deepEqual(describeCalls(result), [
        'sum [function] src/math.ts:5 <- src/math.ts:6:42',
        'Circle.area [method] src/shapes.ts:5 <- src/shapes.ts:6:12 src/shapes.ts:6:44',
      ])
      assert.equal(
        result.calls[1]?.sites[0]?.preview,
        'return add(this.radius, this.radius) + add(1, 2)'
      )
    } finally {
      await project.dispose()
    }
  })

  void test('from a call site the hierarchy is that of the called declaration', async () => {
    const project = await createLanguageProject(Files)
    try {
      const result = await project.services.getCallHierarchy({
        projectRoot: project.projectRoot,
        path: 'src/shapes.ts',
        // `add(this.radius, …)` 里的 add。
        position: positionOf(ShapesFile, 'add', 2),
        direction: 'incoming',
      })
      assert.deepEqual([result.item?.name, result.item?.path, result.item?.line], ['add', 'src/math.ts', 1])
      assert.equal(result.calls.length, 2)
    } finally {
      await project.dispose()
    }
  })

  void test('each level is asked from the position of the caller one level up', async () => {
    const project = await createLanguageProject(Files)
    try {
      const ask = async (path: string, line: number, column: number) =>
        project.services.getCallHierarchy({
          projectRoot: project.projectRoot,
          path,
          position: { line, column },
          direction: 'incoming',
        })

      // add ← Circle.area ← Circle.total ← helper ← 文件最外层。
      const level1 = await ask('src/math.ts', 1, 17)
      const area = level1.calls.find((call) => call.item.name === 'area')?.item
      assert.ok(area)
      const level2 = await ask(area.path, area.line, area.column)
      assert.deepEqual(describeCalls(level2), [
        'Circle.total [method] src/shapes.ts:8 <- src/shapes.ts:9:22 src/shapes.ts:9:35',
      ])
      const total = level2.calls[0]!.item
      const level3 = await ask(total.path, total.line, total.column)
      assert.deepEqual(describeCalls(level3), ['helper [function] src/shapes.ts:13 <- src/shapes.ts:13:51'])
      const helper = level3.calls[0]!.item
      const level4 = await ask(helper.path, helper.line, helper.column)
      // 写在文件最外层的调用：调用方是这个文件，叫它的文件名。
      assert.deepEqual(describeCalls(level4), ['shapes.ts [module] src/shapes.ts:1 <- src/shapes.ts:15:13'])
    } finally {
      await project.dispose()
    }
  })

  void test('outgoing: what the function calls, in the order of its body', async () => {
    const project = await createLanguageProject(Files)
    try {
      const result = await project.services.getCallHierarchy({
        projectRoot: project.projectRoot,
        path: 'src/shapes.ts',
        position: positionOf(ShapesFile, 'total'),
        direction: 'outgoing',
      })
      assert.equal(result.item?.name, 'total')
      // 调用处在被问的函数自己的文件里；同一处只列一次。
      assert.deepEqual(describeCalls(result), [
        'sum [function] src/math.ts:5 <- src/shapes.ts:9:12',
        'Circle.area [method] src/shapes.ts:5 <- src/shapes.ts:9:17 src/shapes.ts:9:30',
      ])
    } finally {
      await project.dispose()
    }
  })

  void test('follows the unsaved text of the request file', async () => {
    const project = await createLanguageProject(Files)
    try {
      const unsaved = `// one more line\n${MathFile}\nexport const twice = (value: number): number => add(value, value)\n`
      const result = await project.services.getCallHierarchy({
        projectRoot: project.projectRoot,
        path: 'src/math.ts',
        content: unsaved,
        position: positionOf(unsaved, 'add'),
        direction: 'incoming',
      })
      assert.deepEqual([result.item?.line, result.item?.column], [2, 17])
      assert.deepEqual(
        describeCalls(result).filter((line) => line.includes('src/math.ts:')),
        [
          'sum [function] src/math.ts:6 <- src/math.ts:7:42',
          'twice [function] src/math.ts:10 <- src/math.ts:10:49',
        ]
      )
    } finally {
      await project.dispose()
    }
  })

  void test('nothing to show off a callable, and for files TypeScript does not serve', async () => {
    const project = await createLanguageProject({ ...Files, 'notes.md': '# add\n' })
    try {
      const onKeyword = await project.services.getCallHierarchy({
        projectRoot: project.projectRoot,
        path: 'src/shapes.ts',
        position: positionOf(ShapesFile, 'return'),
        direction: 'incoming',
      })
      assert.deepEqual([onKeyword.item, onKeyword.calls], [null, []])

      const markdown = await project.services.getCallHierarchy({
        projectRoot: project.projectRoot,
        path: 'notes.md',
        position: { line: 1, column: 3 },
        direction: 'incoming',
      })
      assert.deepEqual([markdown.item, markdown.calls], [null, []])
    } finally {
      await project.dispose()
    }
  })
})
