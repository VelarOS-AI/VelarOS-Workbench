import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { describe, test } from 'bun:test'

import {
  highlightWorkbenchConsoleOutput,
  highlightWorkbenchConsoleOutputSequence,
  type WorkbenchConsoleOutputToken,
} from '../src/renderer/src/models/commands/workbenchConsoleOutputHighlight'

function joinedText(tokens: readonly WorkbenchConsoleOutputToken[]): string {
  return tokens.map((token) => token.text).join('')
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

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
        '\u001B[38;5;31mindexed\u001B[0m \u001B[38;2;12;34;56mtruecolor\u001B[0m \u001B[38:2::45:67:89mcolon\u001B[0m'
      ),
      [
        { text: 'indexed', kind: 'ansiCustom', color: 'rgb(0 135 175)' },
        { text: ' ', kind: 'plain' },
        { text: 'truecolor', kind: 'ansiCustom', color: 'rgb(12 34 56)' },
        { text: ' ', kind: 'plain' },
        { text: 'colon', kind: 'ansiCustom', color: 'rgb(45 67 89)' },
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

  void test('highlights common V8, Node, Bun, URL and Windows stack frames without losing text', () => {
    const cases: ReadonlyArray<{
      input: string
      expected: readonly WorkbenchConsoleOutputToken[]
    }> = [
      {
        input: '    at <anonymous>',
        expected: [
          { text: '    at ', kind: 'plain' },
          { text: '<anonymous>', kind: 'stackPath' },
        ],
      },
      {
        input: '    at String.match (<anonymous>)',
        expected: [
          { text: '    at ', kind: 'plain' },
          { text: 'String.match', kind: 'stackFunction' },
          { text: ' (', kind: 'plain' },
          { text: '<anonymous>', kind: 'stackPath' },
          { text: ')', kind: 'plain' },
        ],
      },
      {
        input: '    at async bootstrap (file:///Users/mac/AirJelly/src/main.ts:18:7)',
        expected: [
          { text: '    at ', kind: 'plain' },
          { text: 'async bootstrap', kind: 'stackFunction' },
          { text: ' (', kind: 'plain' },
          { text: 'file:///Users/mac/AirJelly/src/main.ts', kind: 'stackPath' },
          { text: ':18:7)', kind: 'plain' },
        ],
      },
      {
        input: '    at async Promise.all (index 0)',
        expected: [
          { text: '    at ', kind: 'plain' },
          { text: 'async Promise.all', kind: 'stackFunction' },
          { text: ' (', kind: 'plain' },
          { text: 'index 0', kind: 'stackPath' },
          { text: ')', kind: 'plain' },
        ],
      },
      {
        input: '    at new Runner (C:\\Users\\mac\\Air Jelly\\src\\main.ts:9:2)',
        expected: [
          { text: '    at ', kind: 'plain' },
          { text: 'new Runner', kind: 'stackFunction' },
          { text: ' (', kind: 'plain' },
          {
            text: 'C:\\Users\\mac\\Air Jelly\\src\\main.ts',
            kind: 'stackPath',
          },
          { text: ':9:2)', kind: 'plain' },
        ],
      },
      {
        input: '    at node:internal/process/task_queues:95:5',
        expected: [
          { text: '    at ', kind: 'plain' },
          { text: 'node:internal/process/task_queues', kind: 'stackPath' },
          { text: ':95:5', kind: 'plain' },
        ],
      },
      {
        input: '    at fn (/x/a.ts:1:2) trailing',
        expected: [
          { text: '    at ', kind: 'plain' },
          { text: 'fn', kind: 'stackFunction' },
          { text: ' (', kind: 'plain' },
          { text: '/x/a.ts', kind: 'stackPath' },
          { text: ':1:2) trailing', kind: 'plain' },
        ],
      },
    ]

    for (const { input, expected } of cases) {
      const tokens = highlightWorkbenchConsoleOutput(input)
      assert.deepEqual(tokens, expected)
      assert.equal(joinedText(tokens), input)
    }
  })

  void test('falls back once for unsupported at-lines instead of recursively redispatching them', () => {
    const input = '    at unsupported frame shape'
    const tokens = highlightWorkbenchConsoleOutput(input)

    assert.deepEqual(tokens, [{ text: input, kind: 'plain' }])
    assert.equal(joinedText(tokens), input)
  })

  void test('keeps semantic roles distinct and lets URLs outrank literals inside them', () => {
    const input =
      '2026-09-05T10:11:12.123Z  [ERROR] {"enabled":true,"count":42,"note":"false 7"} https://localhost:5173/?enabled=true&count=42'

    assert.deepEqual(highlightWorkbenchConsoleOutput(input), [
      { text: '2026-09-05T10:11:12.123Z', kind: 'timestamp' },
      { text: '  ', kind: 'plain' },
      { text: '[ERROR]', kind: 'levelError' },
      { text: ' {', kind: 'plain' },
      { text: '"enabled":', kind: 'jsonKey' },
      { text: 'true', kind: 'boolean' },
      { text: ',', kind: 'plain' },
      { text: '"count":', kind: 'jsonKey' },
      { text: '42', kind: 'number' },
      { text: ',', kind: 'plain' },
      { text: '"note":', kind: 'jsonKey' },
      { text: '"false 7"', kind: 'string' },
      { text: '} ', kind: 'plain' },
      { text: 'https://localhost:5173/?enabled=true&count=42', kind: 'link' },
    ])

    assert.deepEqual(
      highlightWorkbenchConsoleOutput('{"url":"https://localhost:5173/?ok=true&count=42"}'),
      [
        { text: '{', kind: 'plain' },
        { text: '"url":', kind: 'jsonKey' },
        { text: '"', kind: 'string' },
        { text: 'https://localhost:5173/?ok=true&count=42', kind: 'link' },
        { text: '"', kind: 'string' },
        { text: '}', kind: 'plain' },
      ]
    )
  })

  void test('does not mistake prose or paths for JSON keys and includes signs in numbers', () => {
    const prose = 'Error: failed; path src/a.ts: unavailable'
    assert.deepEqual(highlightWorkbenchConsoleOutput(prose), [{ text: prose, kind: 'plain' }])
    assert.equal(
      highlightWorkbenchConsoleOutput('Error: 500').some((token) => token.kind === 'jsonKey'),
      false
    )
    assert.deepEqual(highlightWorkbenchConsoleOutput('{ok: true, count: -12}'), [
      { text: '{', kind: 'plain' },
      { text: 'ok:', kind: 'jsonKey' },
      { text: ' ', kind: 'plain' },
      { text: 'true', kind: 'boolean' },
      { text: ', ', kind: 'plain' },
      { text: 'count:', kind: 'jsonKey' },
      { text: ' ', kind: 'plain' },
      { text: '-12', kind: 'number' },
      { text: '}', kind: 'plain' },
    ])
    assert.deepEqual(highlightWorkbenchConsoleOutput('exit=-12 delta=-1.5e+2'), [
      { text: 'exit=', kind: 'plain' },
      { text: '-12', kind: 'number' },
      { text: ' delta=', kind: 'plain' },
      { text: '-1.5e+2', kind: 'number' },
    ])
  })

  void test('isolates ANSI state by process stream and keeps system and input stateless', () => {
    assert.deepEqual(
      highlightWorkbenchConsoleOutputSequence([
        { text: '\u001B[31mout', stream: 'stdout' },
        { text: 'err', stream: 'stderr' },
        { text: ' more', stream: 'stdout' },
        { text: 'system', stream: 'system' },
        { text: 'input', stream: 'input' },
        { text: '\u001B[0m done', stream: 'stdout' },
      ]),
      [
        [{ text: 'out', kind: 'ansiRed' }],
        [{ text: 'err', kind: 'plain' }],
        [{ text: ' more', kind: 'ansiRed' }],
        [{ text: 'system', kind: 'plain' }],
        [{ text: 'input', kind: 'plain' }],
        [{ text: ' done', kind: 'plain' }],
      ]
    )
  })

  void test('buffers SGR sequences split across output chunks', () => {
    assert.deepEqual(
      highlightWorkbenchConsoleOutputSequence(['before\u001B[3', '1mred', '\u001B[0', 'm plain']),
      [
        [{ text: 'before', kind: 'plain' }],
        [{ text: 'red', kind: 'ansiRed' }],
        [],
        [{ text: ' plain', kind: 'plain' }],
      ]
    )
  })

  void test('maps the complete ANSI 16-color foreground palette', () => {
    const cases: ReadonlyArray<[number, WorkbenchConsoleOutputToken['kind']]> = [
      [30, 'ansiBlack'],
      [31, 'ansiRed'],
      [32, 'ansiGreen'],
      [33, 'ansiYellow'],
      [34, 'ansiBlue'],
      [35, 'ansiMagenta'],
      [36, 'ansiCyan'],
      [37, 'ansiWhite'],
      [90, 'ansiBrightBlack'],
      [91, 'ansiBrightRed'],
      [92, 'ansiBrightGreen'],
      [93, 'ansiBrightYellow'],
      [94, 'ansiBrightBlue'],
      [95, 'ansiBrightMagenta'],
      [96, 'ansiBrightCyan'],
      [97, 'ansiBrightWhite'],
    ]

    for (const [code, kind] of cases) {
      assert.deepEqual(highlightWorkbenchConsoleOutput(`\u001B[${code}mvalue\u001B[0m`), [
        { text: 'value', kind },
      ])

      const paletteIndex = code >= 90 ? code - 90 + 8 : code - 30
      assert.deepEqual(
        highlightWorkbenchConsoleOutput(`\u001B[38;5;${paletteIndex}mvalue\u001B[0m`),
        [{ text: 'value', kind }]
      )
    }
  })

  void test('bounds semantic spans for unusually large process chunks while preserving text', () => {
    const input = '1 '.repeat(5_000)
    const tokens = highlightWorkbenchConsoleOutput(input)

    assert.ok(tokens.length <= 4_097)
    assert.equal(joinedText(tokens), input)
  })

  void test('uses one theme-aware terminal palette instead of status or fixed-white colors', () => {
    const shellStyles = source('src/renderer/src/styles/01-shell.module.css')
    const terminalStyles = source('src/renderer/src/styles/12-actions-terminal.module.css')
    const ansiRules = terminalStyles.slice(
      terminalStyles.indexOf('.consoleAnsiBlack'),
      terminalStyles.indexOf('.commandEmpty')
    )

    for (const variable of [
      '--workbench-terminal-ansi-red',
      '--workbench-terminal-ansi-green',
      '--workbench-terminal-ansi-yellow',
      '--workbench-terminal-ansi-blue',
      '--workbench-terminal-ansi-magenta',
      '--workbench-terminal-ansi-cyan',
    ]) {
      assert.equal(shellStyles.match(new RegExp(`${variable}:`, 'g'))?.length, 4)
      assert.match(ansiRules, new RegExp(`var\\(${variable}\\)`))
    }

    assert.doesNotMatch(ansiRules, /--status-/)
    assert.doesNotMatch(ansiRules, /,\s*white\)/)
    assert.match(
      terminalStyles,
      /\.consoleLink \{[^}]*color: var\(--workbench-editor-hover-link\)/s
    )
    assert.match(
      terminalStyles,
      /\.terminalOutputLine\[data-stream='stderr'\] \{\s*color: var\(--foreground\)/s
    )
  })
})
