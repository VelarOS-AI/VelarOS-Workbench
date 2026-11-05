import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from '@playwright/test'
import { test } from 'bun:test'
import { build } from 'esbuild'

test('terminal selection copies, output clicks do not interrupt, and input clicks do', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { acquireWorkbenchTerminal, mountWorkbenchTerminal } from './src/renderer/src/components/terminal/workbenchTerminalInstances';
        window.sent = [];
        const instance = acquireWorkbenchTerminal('test', { onData: data => window.sent.push(data), onOpenLink() {} }, {fontFamily:'monospace',cwd:'.'});
        mountWorkbenchTerminal('test', document.querySelector('#terminal'));
        window.term = instance.terminal;`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'empty' },
    tsconfig: path.resolve('tsconfig.json'),
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(
      '<div id="terminal" class="terminalViewHost" style="width:800px;height:400px"></div>'
    )
    await page.addStyleTag({
      content: await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8'),
    })
    const styles = await readFile('src/renderer/src/styles/12-actions-terminal.module.css', 'utf8')
    const scrollbarStyles = styles
      .slice(styles.indexOf('/* xterm 6'), styles.indexOf('/* xterm 自带'))
      .replace(/:global\(([^)]+)\)/gu, '$1')
    await page.addStyleTag({ content: scrollbarStyles })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.evaluate(async () => {
      const w = window as any
      await new Promise<void>((resolve) => w.term.write('copy me\r\noutput\r\n> ', resolve))
      w.term.focus()
      w.term.select(0, 0, 7)
    })
    await page.keyboard.press('Control+c')
    assert.deepEqual(await page.evaluate(() => (window as any).sent), [])
    // 浏览器 copy 事件必须仍由 xterm 写入文本，而不是发 ETX。
    assert.equal(
      await page.evaluate(() => {
        const clipboardData = new DataTransfer()
        document
          .querySelector('.xterm')!
          .dispatchEvent(
            new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })
          )
        return clipboardData.getData('text/plain')
      }),
      'copy me'
    )
    await page.evaluate(() => (window as any).term.clearSelection())
    const rect = await page.locator('.xterm-screen').boundingBox()
    assert.ok(rect)
    const rows = await page.evaluate(() => (window as any).term.rows)
    await page.mouse.click(rect.x + 10, rect.y + rect.height / rows / 2)
    await page.keyboard.press('Control+c')
    assert.deepEqual(await page.evaluate(() => (window as any).sent), [])
    await page.mouse.click(rect.x + 150, rect.y + (rect.height / rows) * 3.5)
    await page.keyboard.press('Control+c')
    assert.deepEqual(await page.evaluate(() => (window as any).sent), ['\u0003'])
    await page.evaluate(async () => {
      const w = window as any
      await new Promise<void>((resolve) => w.term.write('\r\nline'.repeat(100), resolve))
      w.term.scrollToTop()
      w.sent = []
    })
    await page.keyboard.press('Control+c')
    assert.deepEqual(await page.evaluate(() => (window as any).sent), [])
    assert.equal(
      await page.locator('.scrollbar.vertical').evaluate((el) => el.getBoundingClientRect().width),
      6
    )
    assert.deepEqual(
      await page.locator('.scrollbar.vertical .slider').evaluate((el) => {
        const style = getComputedStyle(el)
        return [style.borderRadius, style.backgroundColor]
      }),
      ['999px', 'rgba(127, 127, 127, 0.16)']
    )
  } finally {
    await browser.close()
  }
}, 30_000)
