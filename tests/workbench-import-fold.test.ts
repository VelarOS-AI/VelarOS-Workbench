import assert from 'node:assert/strict'

import { foldable } from '@codemirror/language'
import { EditorState, Text } from '@codemirror/state'
import { describe, test } from 'bun:test'

import {
  findWorkbenchImportFoldRange,
  workbenchImportFoldExtension,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorImportFold'

/** 折叠区的首末行号：从首条 import 的行尾收起，到最后一条 import 的行尾为止。 */
function foldedImportLines(lines: readonly string[]): Nullable<[number, number]> {
  const doc = Text.of([...lines])
  const range = findWorkbenchImportFoldRange(doc)
  if (!range) return null

  const first = doc.lineAt(range.from)
  const last = doc.lineAt(range.to)
  assert.equal(range.from, first.to)
  assert.equal(range.to, last.to)
  return [first.number, last.number]
}

const SearchToolHeader = [
  "import { z } from 'zod'",
  '',
  'import {',
  '  renderParameterDescription as parameterDescription,',
  '  requiredResultLimit,',
  "} from '@velaros-ai/velaros/agent/tool-contract'",
  '',
  "import { executeAtomicGrep } from '../../impl/atomic/Grep.js'",
  "import { SystemToolNames } from '../tool-names.js'",
  '',
  "import { defineSystemTool } from './define.js'",
  '',
  '/**',
  ' * system:search — 在系统路径上搜索文本匹配。',
  ' */',
  'export const searchTool = defineSystemTool<{',
  '  path: string',
  '}>({})',
]

void describe('Workbench import folding', () => {
  void test('folds every import group, including the lines of a multi-line import', () => {
    assert.deepEqual(foldedImportLines(SearchToolHeader), [1, 11])
  })

  void test('a file that opens with a multi-line import folds through its last import', () => {
    assert.deepEqual(
      foldedImportLines([
        'import {',
        '  forwardRef,',
        '  useEffect,',
        "} from 'react'",
        'import { createPortal } from "react-dom"',
        '',
        'const log = createLog()',
      ]),
      [1, 5]
    )
    assert.deepEqual(
      foldedImportLines([
        'import {',
        '  useState,',
        "} from 'react'",
        '',
        'export function App() {}',
      ]),
      [1, 3]
    )
  })

  void test('skips a shebang, header comments and directives in front of the first import', () => {
    assert.deepEqual(
      foldedImportLines([
        '#!/usr/bin/env node',
        '/**',
        ' * import nothing from here: this is a license header',
        ' */',
        "'use client'",
        '"use strict";',
        '/// <reference types="vite/client" />',
        '',
        "import a from 'a'",
        "import b from 'b'",
        '',
        '// belongs to the code below, stays visible',
        'export const value = a + b',
      ]),
      [9, 10]
    )
  })

  void test('brackets inside strings and comments do not break a statement apart', () => {
    assert.deepEqual(
      foldedImportLines([
        "import { a } from './{weird}' // trailing {",
        'import {',
        '  b, // }',
        '  /* } */ c,',
        "} from 'b'",
        '// comment between imports',
        "import type { T } from 't'",
        'import Default from',
        "  'module'",
        '',
        'run()',
      ]),
      [1, 9]
    )
  })

  void test('an import still being typed does not swallow the code after it', () => {
    assert.deepEqual(
      foldedImportLines([
        "import a from 'a'",
        "import b from 'b'",
        'import {',
        'const value = compute()',
        'export function run() {',
        '  return value',
        '}',
      ]),
      [1, 2]
    )
    assert.equal(foldedImportLines(['import {', 'const value = 1', 'run(value)']), null)
  })

  void test('covers Python docstrings, from-imports and parenthesized import lists', () => {
    assert.deepEqual(
      foldedImportLines([
        '#!/usr/bin/env python3',
        '"""Module docstring.',
        '',
        'import os  <- still inside the docstring',
        '"""',
        'from __future__ import annotations',
        '',
        'import os',
        'from typing import (',
        '    Any,  # )',
        '    Dict,',
        ')',
        '',
        'def main() -> None:',
        '    pass',
      ]),
      [6, 12]
    )
  })

  void test('lets a package clause precede the imports (Java, Go)', () => {
    assert.deepEqual(
      foldedImportLines([
        '// Copyright',
        'package com.example.app;',
        '',
        'import java.util.List;',
        'import java.util.Map;',
        '',
        'public class App {}',
      ]),
      [4, 5]
    )
    assert.deepEqual(
      foldedImportLines([
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"os"',
        ')',
        '',
        'func main() {}',
      ]),
      [3, 6]
    )
  })

  void test('leaves files without a leading multi-line import section unfolded', () => {
    assert.equal(foldedImportLines(['']), null)
    assert.equal(
      foldedImportLines(["import { z } from 'zod'", '', 'export const schema = z.string()']),
      null
    )
    assert.equal(
      foldedImportLines([
        "const legacy = require('legacy')",
        "import a from 'a'",
        "import b from 'b'",
      ]),
      null
    )
    assert.equal(
      foldedImportLines(["import('./setup')", 'import.meta.hot?.accept()', 'start()']),
      null
    )
    assert.equal(
      foldedImportLines(['/*', "import a from 'a'", "import b from 'b'", '*/', 'const x = 1']),
      null
    )
  })

  void test('the fold gutter offers the same range on the first import line only', () => {
    const state = EditorState.create({
      doc: SearchToolHeader.join('\n'),
      extensions: [workbenchImportFoldExtension],
    })
    const range = findWorkbenchImportFoldRange(state.doc)
    const firstLine = state.doc.line(1)
    const multiLineImport = state.doc.line(3)

    assert.ok(range)
    assert.deepEqual(foldable(state, firstLine.from, firstLine.to), range)
    assert.equal(foldable(state, multiLineImport.from, multiLineImport.to), null)

    // 文档一变就按新内容重算，不会沿用上一版的区间。
    const edited = state.update({
      changes: { from: 0, insert: "import first from 'first'\n" },
    }).state
    const editedRange = findWorkbenchImportFoldRange(edited.doc)
    assert.ok(editedRange)
    assert.equal(edited.doc.lineAt(editedRange.from).number, 1)
    assert.equal(edited.doc.lineAt(editedRange.to).number, 12)
  })
})
