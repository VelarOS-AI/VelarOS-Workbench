import { describe, expect, test } from 'bun:test'

import { WorkbenchNavigationHistory } from '../src/renderer/src/models/editor/workbenchNavigationHistory'

const at = (path: string, line: number, column = 1) => ({ path, line, column })

describe('editor navigation history', () => {
  test('goes back to where each jump started and forward again', () => {
    const history = new WorkbenchNavigationHistory()
    history.record(at('a.ts', 10))
    history.record(at('b.ts', 3))
    expect(history.back(at('c.ts', 7))).toEqual(at('b.ts', 3))
    expect(history.back(at('b.ts', 3))).toEqual(at('a.ts', 10))
    expect(history.back(at('a.ts', 10))).toBeNull()
    expect(history.forward(at('a.ts', 10))).toEqual(at('b.ts', 3))
    expect(history.forward(at('b.ts', 3))).toEqual(at('c.ts', 7))
    expect(history.forward(at('c.ts', 7))).toBeNull()
  })

  test('a new jump drops the forward history, and the same line is recorded once', () => {
    const history = new WorkbenchNavigationHistory()
    history.record(at('a.ts', 1))
    history.record(at('a.ts', 1, 9))
    history.record(at('b.ts', 2))
    expect(history.back(at('c.ts', 5))).toEqual(at('b.ts', 2))
    history.record(at('b.ts', 2))
    expect(history.forward(at('d.ts', 1))).toBeNull()
    expect(history.back(at('d.ts', 1))).toEqual(at('b.ts', 2))
    expect(history.back(at('b.ts', 2))).toEqual(at('a.ts', 1))
    expect(history.back(at('a.ts', 1))).toBeNull()
  })

  test('skips entries equal to where the cursor already is', () => {
    const history = new WorkbenchNavigationHistory()
    history.record(at('a.ts', 4))
    history.record(at('b.ts', 8))
    expect(history.back(at('b.ts', 8, 3))).toEqual(at('a.ts', 4))
  })
})
