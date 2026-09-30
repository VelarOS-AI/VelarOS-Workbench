import { describe, expect, test } from 'bun:test'

import {
  buildWorkbenchTerminalFindPattern,
  DefaultWorkbenchTerminalFindOptions,
  findWorkbenchTerminalTextMatches,
  type WorkbenchTerminalFindOptions,
} from '../src/renderer/src/models/commands/workbenchTerminalFind'

/** 按查找词与开关项在一段文字里找，给出每处匹配的文字。 */
function matches(
  text: string,
  query: string,
  options: Partial<WorkbenchTerminalFindOptions> = {},
  limit = 100
): string[] | 'invalid' | null {
  const pattern = buildWorkbenchTerminalFindPattern(query, {
    ...DefaultWorkbenchTerminalFindOptions,
    ...options,
  })
  if (pattern === null || pattern === 'invalid') return pattern
  return findWorkbenchTerminalTextMatches(text, pattern, limit).map(([start, end]) =>
    text.slice(start, end)
  )
}

describe('finding text in the terminal', () => {
  test('plain text ignores case by default and takes special characters literally', () => {
    expect(matches('Error: x. error: y', 'error')).toEqual(['Error', 'error'])
    expect(matches('Error: x. error: y', 'error', { caseSensitive: true })).toEqual(['error'])
    expect(matches('call a.b(c) or ab(c)', 'a.b(c)')).toEqual(['a.b(c)'])
    expect(matches('C:\\tmp\\x [1] $HOME', '\\tmp\\x [1] $')).toEqual(['\\tmp\\x [1] $'])
  })

  test('whole words are not part of a longer word, in any script', () => {
    expect(matches('log login blog log. (log)', 'log', { wholeWord: true })).toEqual([
      'log',
      'log',
      'log',
    ])
    expect(matches('测试用例 与 测试', '测试', { wholeWord: true })).toEqual(['测试'])
    expect(matches('snake_case case', 'case', { wholeWord: true })).toEqual(['case'])
  })

  test('regular expressions, with invalid ones reported and empty matches skipped', () => {
    expect(matches('done in 12ms, then 340ms', String.raw`\d+ms`, { regexp: true })).toEqual([
      '12ms',
      '340ms',
    ])
    expect(matches('anything', '(', { regexp: true })).toBe('invalid')
    expect(matches('baaa b', 'a*', { regexp: true })).toEqual(['aaa'])
    expect(matches('😀a😀a', 'x*', { regexp: true })).toEqual([])
    expect(matches('abc', '')).toBeNull()
  })

  test('stops at the limit', () => {
    expect(matches('a a a a a', 'a', {}, 3)).toEqual(['a', 'a', 'a'])
  })
})
