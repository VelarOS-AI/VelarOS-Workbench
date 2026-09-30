import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { WorkbenchLanguageServiceDocumentSymbol } from '../src/shared/contracts'

import { createLanguageProject, StrictTsconfig } from './helpers/languageProject'

const Shapes = [
  "import { helper } from './helper'",
  '',
  'export interface Shape {',
  '  area(): number',
  '  name: string',
  '}',
  '',
  'export enum Color {',
  '  Red,',
  '  Green,',
  '}',
  '',
  'export type Id = string',
  '',
  'export const LIMIT = 10',
  'let counter = 0',
  '',
  'export class Circle implements Shape {',
  '  name = "circle"',
  '  constructor(private readonly radius: number) {}',
  '  get diameter(): number {',
  '    return this.radius * 2',
  '  }',
  '  area(): number {',
  '    const square = (value: number) => value * value',
  '    return Math.PI * square(this.radius)',
  '  }',
  '}',
  '',
  'export function create(radius: number): Circle {',
  '  function validate(): void {}',
  '  validate()',
  '  return new Circle(radius + helper + counter)',
  '}',
  '',
  'namespace Internal {',
  '  export const flag = true',
  '}',
  '',
  'describe("circle", () => {',
  '  it("has an area", () => {',
  '    create(1)',
  '  })',
  '})',
  '',
].join('\n')

/** 大纲的样子：每行「缩进 名字 [种类] 行:列」。 */
function outline(symbols: readonly WorkbenchLanguageServiceDocumentSymbol[]): string[] {
  return symbols.map(
    (symbol) => `${'  '.repeat(symbol.depth)}${symbol.name} [${symbol.kind}] ${symbol.line}:${symbol.column}`
  )
}

void describe('document symbols (outline)', () => {
  void test('TypeScript: nested, in file order, each declaration once, imports left out', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/helper.ts': 'export const helper = 1\n',
      'src/shapes.ts': Shapes,
    })
    try {
      const result = await project.services.getDocumentSymbols({
        projectRoot: project.projectRoot,
        path: 'src/shapes.ts',
      })
      assert.deepEqual(outline(result.symbols), [
        'Shape [interface] 3:18',
        '  area [method] 4:3',
        '  name [property] 5:3',
        'Color [enum] 8:13',
        '  Red [enum-member] 9:3',
        '  Green [enum-member] 10:3',
        'Id [type] 13:13',
        'LIMIT [constant] 15:14',
        'counter [variable] 16:5',
        'Circle [class] 18:14',
        '  name [property] 19:3',
        '  constructor [constructor] 20:3',
        '  radius [property] 20:32',
        '  diameter [property] 21:7',
        '  area [method] 24:3',
        '    square [constant] 25:11',
        'create [function] 30:17',
        '  validate [function] 31:12',
        'Internal [module] 36:11',
        '  flag [constant] 37:16',
        'describe("circle") callback [function] 40:20',
        '  it("has an area") callback [function] 41:21',
      ])

      // 范围盖住整个声明：光标在类的方法体里时，类与方法都算「包着光标」。
      const circle = result.symbols.find((symbol) => symbol.name === 'Circle')
      assert.deepEqual([circle?.range.startLine, circle?.range.endLine], [18, 28])
      const area = result.symbols.find((symbol) => symbol.name === 'area' && symbol.kind === 'method' && symbol.depth === 1 && symbol.line === 24)
      assert.deepEqual([area?.range.startLine, area?.range.endLine], [24, 27])
    } finally {
      await project.dispose()
    }
  })

  void test('TypeScript: follows the unsaved text', async () => {
    const project = await createLanguageProject({
      'tsconfig.json': StrictTsconfig,
      'src/main.ts': 'export const saved = 1\n',
    })
    try {
      const result = await project.services.getDocumentSymbols({
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content: '// a comment first\nexport function unsaved(): void {}\n',
      })
      assert.deepEqual(outline(result.symbols), ['unsaved [function] 2:17'])
    } finally {
      await project.dispose()
    }
  })

  void test('JavaScript and JSX files have an outline too', async () => {
    const project = await createLanguageProject({
      'app.jsx': 'export function App() {\n  const title = "hi"\n  return <h1>{title}</h1>\n}\n\nclass Store {\n  load() {}\n}\n',
    })
    try {
      const result = await project.services.getDocumentSymbols({
        projectRoot: project.projectRoot,
        path: 'app.jsx',
      })
      assert.deepEqual(outline(result.symbols), [
        'App [function] 1:17',
        '  title [constant] 2:9',
        'Store [class] 6:7',
        '  load [method] 7:3',
      ])
    } finally {
      await project.dispose()
    }
  })

  void test('Markdown: headings nest by level', async () => {
    const project = await createLanguageProject({
      'README.md': '# Title\n\nintro\n\n## Install\n\ntext\n\n### Details\n\n## Usage\n',
    })
    try {
      const result = await project.services.getDocumentSymbols({
        projectRoot: project.projectRoot,
        path: 'README.md',
      })
      assert.deepEqual(
        result.symbols.map((symbol) => `${'  '.repeat(symbol.depth)}${symbol.name} ${symbol.line}`),
        ['Title 1', '  Install 5', '    Details 9', '  Usage 11']
      )
    } finally {
      await project.dispose()
    }
  })

  void test('files without a language service that knows symbols give none', async () => {
    const project = await createLanguageProject({ 'notes.txt': 'function notReally() {}\n' })
    try {
      const result = await project.services.getDocumentSymbols({
        projectRoot: project.projectRoot,
        path: 'notes.txt',
      })
      assert.deepEqual(result.symbols, [])
    } finally {
      await project.dispose()
    }
  })
})
