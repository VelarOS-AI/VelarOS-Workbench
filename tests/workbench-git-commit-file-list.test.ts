import { chromium, expect } from '@playwright/test'
import { afterAll, test } from 'bun:test'
import { build, stop } from 'esbuild'

afterAll(() => stop())

test('the commit list keeps 9,000 files scrollable without mounting all rows', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createElement } from 'react'
        import { createRoot } from 'react-dom/client'
        import { WorkbenchCommitFileList } from './src/renderer/src/components/git/WorkbenchCommitFileList'

        const items = Array.from({ length: 9000 }, (_, index) => ({ path: 'changed-' + index }))
        createRoot(document.querySelector('#app')).render(
          createElement('div', { 'data-slot': 'scroll-area' },
            createElement(WorkbenchCommitFileList, { items },
              (item) => createElement('button', { key: item.path, 'data-file': item.path }, item.path)))
        )
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'empty', '.module.css': 'empty' },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <style>
        [data-slot="scroll-area"] { height: 240px; overflow-y: auto }
        [data-file] { display: block; height: var(--commit-file-row-height) }
      </style>
      <div id="app"></div>
    `)
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const rows = page.locator('[data-file]')
    await expect(rows.first()).toHaveText('changed-0')
    expect(await rows.count()).toBeLessThan(40)

    const scroll = page.locator('[data-slot="scroll-area"]')
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(rows.last()).toHaveText('changed-8999')
    expect(await rows.count()).toBeLessThan(40)
    await expect(page.getByRole('button', { name: 'changed-0', exact: true })).toHaveCount(0)
  } finally {
    await browser.close()
  }
}, 15_000)
