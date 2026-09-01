import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  highlightWorkbenchConsoleOutput,
  highlightWorkbenchConsoleOutputSequence,
} from '../src/renderer/src/models/commands/workbenchConsoleOutputHighlight'

void describe('Workbench console output highlighting', () => {
  void test('keeps the foreground through style-only SGR codes and resets it with 39', () => {
    assert.deepEqual(highlightWorkbenchConsoleOutput('\u001B[31mred\u001B[1m bold\u001B[39m plain'), [
      { text: 'red bold', kind: 'ansiRed' },
      { text: ' plain', kind: 'plain' },
    ])
  })

  void test('renders indexed and true-color foregrounds without treating payloads as ANSI codes', () => {
    assert.deepEqual(
      highlightWorkbenchConsoleOutput(
        '\u001B[38;5;31mindexed\u001B[0m \u001B[38;2;12;34;56mtruecolor\u001B[0m'
      ),
      [
        { text: 'indexed', kind: 'ansiCustom', color: 'rgb(0 135 175)' },
        { text: ' ', kind: 'plain' },
        { text: 'truecolor', kind: 'ansiCustom', color: 'rgb(12 34 56)' },
      ]
    )
  })

  void test('does not reinterpret extended background palette values as foreground colors', () => {
    assert.deepEqual(
      highlightWorkbenchConsoleOutput('\u001B[48;5;31mbackground only\u001B[0m'),
      [{ text: 'background only', kind: 'plain' }]
    )
  })

  void test('keeps colored URLs clickable', () => {
    assert.deepEqual(
      highlightWorkbenchConsoleOutput('\u001B[32mhttps://localhost:5173/\u001B[0m'),
      [{ text: 'https://localhost:5173/', kind: 'link' }]
    )
  })

  void test('carries ANSI foreground state across process output chunks', () => {
    assert.deepEqual(
      highlightWorkbenchConsoleOutputSequence(['\u001B[35mfirst', ' second', '\u001B[0m plain']),
      [
        [{ text: 'first', kind: 'ansiMagenta' }],
        [{ text: ' second', kind: 'ansiMagenta' }],
        [{ text: ' plain', kind: 'plain' }],
      ]
    )
  })
})
