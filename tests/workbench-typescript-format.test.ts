import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'
import * as ts from 'typescript'

import { buildTypeScriptFormatEdits } from '../src/main/workspace/language/TypeScriptLanguageFeatures'

function createService(fileName: string, content: string): ts.LanguageService {
  return ts.createLanguageService({
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => (name === fileName ? ts.ScriptSnapshot.fromString(content) : undefined),
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({}),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? content : undefined),
  })
}

/** 按 1 基行列把编辑套回原文（从后往前套，前面的位置不受影响）。 */
function applyEdits(content: string, edits: ReturnType<typeof buildTypeScriptFormatEdits>): string {
  const lineStarts = [0]
  for (let index = 0; index < content.length; index += 1) if (content[index] === '\n') lineStarts.push(index + 1)
  const offset = (line: number, column: number) => (lineStarts[line - 1] ?? content.length) + column - 1
  return [...edits]
    .map((edit) => ({
      from: offset(edit.range.startLine, edit.range.startColumn),
      to: offset(edit.range.endLine, edit.range.endColumn),
      text: edit.newText,
    }))
    .sort((left, right) => right.from - left.from)
    .reduce((text, edit) => text.slice(0, edit.from) + edit.text + text.slice(edit.to), content)
}

void describe('Workbench built-in TypeScript formatting', () => {
  void test('keeps the usual spacing instead of squeezing operators and commas together', () => {
    const fileName = '/project/src/math.ts'
    const content = [
      'export function divide(left: number,right: number): number {',
      'if(right===0) {',
      "throw new Error('Cannot divide by zero')",
      '}',
      'return left/right',
      '}',
      '',
    ].join('\n')
    const formatted = applyEdits(
      content,
      buildTypeScriptFormatEdits({ service: createService(fileName, content), fileName, content })
    )
    assert.equal(
      formatted,
      [
        'export function divide(left: number, right: number): number {',
        '  if (right === 0) {',
        "    throw new Error('Cannot divide by zero')",
        '  }',
        '  return left / right',
        '}',
        '',
      ].join('\n')
    )
  })
})
