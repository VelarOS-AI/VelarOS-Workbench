import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { describe, test } from 'bun:test'

import {
  installWorkbenchExternalNavigation,
  normalizeWorkbenchExternalUrl,
  type WorkbenchWindowOpenHandler,
} from '../src/main/projects/WorkbenchExternalNavigation'

void describe('Workbench external navigation', () => {
  void test('only hands validated external destinations to the system browser', async () => {
    let handler: WorkbenchWindowOpenHandler | undefined
    const opened: string[] = []
    installWorkbenchExternalNavigation(
      (nextHandler) => {
        handler = nextHandler
      },
      async (url) => {
        opened.push(url)
      }
    )

    assert.ok(handler)
    const destinations = [
      'http://127.0.0.1:7173/',
      'https://example.com/path?q=1',
      'mailto:user@example.com?subject=Workbench',
      'https://user:secret@example.com/',
      'https://example.com/path\nwith-control-character',
      'file:///tmp/private.txt',
      'javascript:alert(1)',
      'data:text/html,unsafe',
      'not a URL',
    ]
    for (const url of destinations) {
      assert.deepEqual(handler({ url }), { action: 'deny' })
    }

    assert.deepEqual(opened, [
      'http://127.0.0.1:7173/',
      'https://example.com/path?q=1',
      'mailto:user@example.com?subject=Workbench',
    ])
  })

  void test('denies the Electron child window even when external launch fails', async () => {
    let handler: WorkbenchWindowOpenHandler | undefined
    const failures: Array<{ url: string; error: unknown }> = []
    const failure = new Error('browser unavailable')
    installWorkbenchExternalNavigation(
      (nextHandler) => {
        handler = nextHandler
      },
      async () => {
        throw failure
      },
      (url, error) => failures.push({ url, error })
    )

    assert.ok(handler)
    assert.deepEqual(handler({ url: 'https://example.com/' }), { action: 'deny' })
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(failures, [{ url: 'https://example.com/', error: failure }])
  })

  void test('installs the policy on Workbench windows without replacing internal link callbacks', async () => {
    const [main, consoleOutput] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/renderer/src/components/terminal/WorkbenchConsoleOutputLine.tsx', 'utf8'),
    ])

    assert.match(
      main,
      /installWorkbenchExternalNavigation\([\s\S]*setWindowOpenHandler\(handler\)[\s\S]*shell\.openExternal\(url\)/u
    )
    assert.match(
      consoleOutput,
      /onClick=\{\(\) => \(onOpenLink \? onOpenLink\(url\) : openExternalUrl\(url\)\)\}/u
    )
    assert.match(
      consoleOutput,
      /className=\{styles\.consoleLinkExternal\}[\s\S]{0,220}onClick=\{\(\) => openExternalUrl\(url\)\}/u
    )
  })
})

void test('normalizes supported URLs and rejects unsafe destinations', () => {
  assert.equal(normalizeWorkbenchExternalUrl('HTTP://Example.COM'), 'http://example.com/')
  assert.equal(normalizeWorkbenchExternalUrl('mailto:user@example.com'), 'mailto:user@example.com')
  assert.equal(normalizeWorkbenchExternalUrl('https://user:secret@example.com'), null)
  assert.equal(normalizeWorkbenchExternalUrl('https://example.com/path\twith-control-character'), null)
  assert.equal(normalizeWorkbenchExternalUrl('custom://example.com'), null)
  assert.equal(normalizeWorkbenchExternalUrl(''), null)
})
