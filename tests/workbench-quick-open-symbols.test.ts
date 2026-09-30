import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { workbenchDocumentSymbolGlyphMask } from '../src/renderer/src/models/editor/workbenchSymbolKindGlyphs'
import { parseWorkbenchQuickOpenQuery } from '../src/renderer/src/models/layout/workbenchQuickOpenModel'
import {
  buildWorkbenchQuickOpenSymbolItems,
  findWorkbenchSymbolIndexAtPosition,
} from '../src/renderer/src/models/layout/workbenchQuickOpenSymbols'
import type {
  WorkbenchLanguageServiceDocumentSymbol,
  WorkbenchLanguageServiceDocumentSymbolKind,
} from '../src/shared/contracts'

function symbol(
  name: string,
  kind: WorkbenchLanguageServiceDocumentSymbolKind,
  depth: number,
  startLine: number,
  endLine: number
): WorkbenchLanguageServiceDocumentSymbol {
  return {
    name,
    kind,
    depth,
    line: startLine,
    column: 3 + depth * 2,
    // 一行的声明到行尾，多行的到收尾那个括号。
    range: { startLine, startColumn: 1 + depth * 2, endLine, endColumn: startLine === endLine ? 80 : 2 },
  }
}

// 3–6  interface Shape { area(); name }
// 10–20 class Circle { name; constructor; area() { square } }
// 22–26 function create() { validate() }
// 30 const LIMIT
const Symbols = [
  symbol('Shape', 'interface', 0, 3, 6),
  symbol('area', 'method', 1, 4, 4),
  symbol('name', 'property', 1, 5, 5),
  symbol('Circle', 'class', 0, 10, 20),
  symbol('name', 'property', 1, 11, 11),
  symbol('constructor', 'constructor', 1, 12, 12),
  symbol('area', 'method', 1, 14, 19),
  symbol('square', 'constant', 2, 15, 15),
  symbol('create', 'function', 0, 22, 26),
  symbol('validate', 'function', 1, 23, 23),
  symbol('LIMIT', 'constant', 0, 30, 30),
]

const names = (query: string): string[] =>
  buildWorkbenchQuickOpenSymbolItems({ symbols: Symbols, query }).items.map((item) =>
    item.container ? `${item.container} › ${item.name}` : item.name
  )

void describe('go to symbol in file', () => {
  void test('@ switches Quick Open to the symbols of the current file', () => {
    assert.deepEqual(parseWorkbenchQuickOpenQuery('@'), { mode: 'symbols', text: '', line: null, column: null })
    assert.deepEqual(parseWorkbenchQuickOpenQuery(' @ area '), {
      mode: 'symbols',
      text: 'area',
      line: null,
      column: null,
    })
    // 别的写法不受影响；文件名里的 @ 不在开头就还是找文件。
    assert.equal(parseWorkbenchQuickOpenQuery('>@').mode, 'commands')
    assert.equal(parseWorkbenchQuickOpenQuery(':12').mode, 'line')
    assert.equal(parseWorkbenchQuickOpenQuery('icon@2x.png').mode, 'files')
  })

  void test('without a query the whole outline is listed in file order, nested under its containers', () => {
    const { items, truncated } = buildWorkbenchQuickOpenSymbolItems({ symbols: Symbols, query: '' })
    assert.equal(truncated, false)
    assert.deepEqual(
      items.map((item) => `${'  '.repeat(item.depth)}${item.name} <${item.container}> ${item.kind} ${item.line}`),
      [
        'Shape <> interface 3',
        '  area <Shape> method 4',
        '  name <Shape> property 5',
        'Circle <> class 10',
        '  name <Circle> property 11',
        '  constructor <Circle> constructor 12',
        '  area <Circle> method 14',
        '    square <Circle › area> constant 15',
        'create <> function 22',
        '  validate <create> function 23',
        'LIMIT <> constant 30',
      ]
    )
    assert.deepEqual(items.map((item) => item.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  void test('a query filters by name, fuzzily, and lists matches flat with their container', () => {
    assert.deepEqual(names('area'), ['Shape › area', 'Circle › area'])
    assert.deepEqual(names('crt'), ['create', 'Circle › constructor'])
    assert.deepEqual(names('nothing-like-this'), [])

    const [first] = buildWorkbenchQuickOpenSymbolItems({ symbols: Symbols, query: 'val' }).items
    assert.deepEqual([first?.name, first?.depth, first?.container], ['validate', 0, 'create'])
    assert.deepEqual(first?.nameMatches, [0, 1, 2])
    assert.deepEqual(first?.containerMatches, [])
  })

  void test('a second word may name the container; a container match alone does not list its members', () => {
    // 「Circle 里的 area」：第一段落在外层名字上，第二段落在名字上。
    assert.deepEqual(names('circle area'), ['Circle › area'])
    const [item] = buildWorkbenchQuickOpenSymbolItems({ symbols: Symbols, query: 'circle area' }).items
    assert.deepEqual(item?.nameMatches, [0, 1, 2, 3])
    assert.deepEqual(item?.containerMatches, [0, 1, 2, 3, 4, 5])

    // 只敲外层的名字：列的是它自己，不是它下面所有的。
    assert.deepEqual(names('Circle'), ['Circle'])
    assert.deepEqual(names('shape'), ['Shape'])
  })

  void test('long outlines are cut and say so', () => {
    const many = Array.from({ length: 30 }, (_, index) => symbol(`fn${index}`, 'function', 0, index + 1, index + 1))
    const all = buildWorkbenchQuickOpenSymbolItems({ symbols: many, query: '', limit: 10 })
    assert.equal(all.items.length, 10)
    assert.equal(all.truncated, true)
    const filtered = buildWorkbenchQuickOpenSymbolItems({ symbols: many, query: 'fn1', limit: 10 })
    assert.equal(filtered.items.length, 10)
    assert.equal(filtered.truncated, true)
    assert.equal(buildWorkbenchQuickOpenSymbolItems({ symbols: many, query: 'fn29', limit: 10 }).truncated, false)
  })

  void test('the list opens on the symbol the cursor is in', () => {
    const at = (line: number, column = 5): Nullable<string> => {
      const index = findWorkbenchSymbolIndexAtPosition(Symbols, { line, column })
      return index < 0 ? null : `${Symbols[index]!.name}@${Symbols[index]!.line}`
    }
    // 最里层的那个：方法体里的局部常量、方法、类。
    assert.equal(at(15), 'square@15')
    assert.equal(at(17), 'area@14')
    assert.equal(at(13), 'Circle@10')
    assert.equal(at(4), 'area@4')
    // 两个声明之间的空行：前面最近的那个；文件开头（import 那几行）：第一个。
    assert.equal(at(8), 'name@5')
    assert.equal(at(28), 'validate@23')
    assert.equal(at(1), 'Shape@3')
    assert.equal(at(99), 'LIMIT@30')
    assert.equal(findWorkbenchSymbolIndexAtPosition([], { line: 1, column: 1 }), -1)
  })

  void test('every symbol kind has an icon', () => {
    const kinds: WorkbenchLanguageServiceDocumentSymbolKind[] = [
      'class', 'constant', 'constructor', 'enum', 'enum-member', 'function', 'interface',
      'method', 'module', 'property', 'symbol', 'type', 'variable',
    ]
    for (const kind of kinds)
      assert.match(workbenchDocumentSymbolGlyphMask(kind), /^url\("data:image\/svg\+xml,/u, kind)
    // 类与接口、函数与方法各有各的图形。
    assert.notEqual(workbenchDocumentSymbolGlyphMask('class'), workbenchDocumentSymbolGlyphMask('interface'))
    assert.notEqual(workbenchDocumentSymbolGlyphMask('function'), workbenchDocumentSymbolGlyphMask('method'))
  })
})
