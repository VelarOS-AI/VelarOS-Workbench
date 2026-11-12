import assert from 'node:assert/strict'

import { Terminal } from '@xterm/xterm'
import { test } from 'bun:test'

import { findWorkbenchTerminalWebLinks } from '../src/renderer/src/models/commands/workbenchTerminalWebLinks'

test('terminal external buttons follow parsed ANSI output, wide characters and viewport scroll', async () => {
  const terminal = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
  try {
    await new Promise<void>((done) =>
      terminal.write('\x1b[32m本地: http://localhost:5200/\x1b[0m\r\n', done)
    )
    assert.deepEqual(findWorkbenchTerminalWebLinks(terminal), [
      { url: 'http://localhost:5200/', row: 0, column: 28 },
    ])
    await new Promise<void>((done) => terminal.write('one\r\ntwo\r\nthree\r\nfour\r\n', done))
    assert.deepEqual(findWorkbenchTerminalWebLinks(terminal), [])
    terminal.scrollToTop()
    assert.equal(findWorkbenchTerminalWebLinks(terminal)[0]?.row, 0)
  } finally {
    terminal.dispose()
  }
})

test('wrapped URLs get a button at their visible end without covering adjacent text', async () => {
  const terminal = new Terminal({ cols: 30, rows: 6, allowProposedApi: true })
  const url = 'https://localhost:5200/path/to/page'
  try {
    await new Promise<void>((done) => terminal.write(`Local: ${url}\r\n`, done))
    assert.deepEqual(findWorkbenchTerminalWebLinks(terminal), [{ url, row: 1, column: 12 }])
    await new Promise<void>((done) =>
      terminal.write('http://example.com/ x\r\nhttps://user:pass@example.com/\r\n', done)
    )
    assert.equal(findWorkbenchTerminalWebLinks(terminal).length, 1)
    await new Promise<void>((done) => terminal.write('\x1b[2J\x1b[H', done))
    assert.deepEqual(findWorkbenchTerminalWebLinks(terminal), [])
  } finally {
    terminal.dispose()
  }
})
