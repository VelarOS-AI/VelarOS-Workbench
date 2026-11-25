import { chromium, expect } from '@playwright/test'
import { afterAll, test } from 'bun:test'
import { build, stop } from 'esbuild'

afterAll(() => stop())

test('a healthy sibling does not rearm an unavailable language service notification', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createElement, useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { WorkbenchHostProvider } from './src/renderer/src/host/WorkbenchHostProvider'
        import { useWorkbenchLanguageServiceInsights } from './src/renderer/src/hooks/useWorkbenchLanguageServiceInsights'
        import { WorkbenchLocalizationProvider } from './src/renderer/src/i18n/WorkbenchLocalizationProvider'
        import { workbenchMessage } from './src/renderer/src/runtime/workbenchMessageHost'

        const requests = document.querySelector('#requests')
        const notifications = document.querySelector('#notifications')
        workbenchMessage.error = ({ description }) => {
          notifications.append(Object.assign(document.createElement('li'), { textContent: description }))
        }
        const runtime = { kernel: { project: {
          async getWorkbenchLanguageServiceDiagnostics({ projectRoot, path }) {
            requests.append(Object.assign(document.createElement('li'), { textContent: projectRoot + '/' + path }))
            if (path.endsWith('.vue')) {
              return { ok: false, error: { code: 'UNAVAILABLE', message: 'Vue language server unavailable' } }
            }
            return { ok: true, data: { projectRoot, path, diagnostics: [] } }
          },
        } } }
        const localization = { locale: 'en-US', t: key => key, async setLocale() {} }
        const tabs = ['App.vue', 'style.css'].map(path => ({ path, content: '', file: { content: '' } }))

        function Diagnostics() {
          const [externalRevision, setRevision] = useState(0)
          const [projectRoot, setProjectRoot] = useState('/first')
          useWorkbenchLanguageServiceInsights({
            projectRoot, openTabs: tabs, selectedFilePath: 'App.vue', editorContent: '', externalRevision,
          })
          return [
            createElement('button', { key: 'refresh', onClick: () => setRevision(value => value + 1) }, 'Refresh'),
            createElement('button', { key: 'switch', onClick: () => setProjectRoot('/second') }, 'Switch workspace'),
          ]
        }

        createRoot(document.querySelector('#app')).render(
          createElement(WorkbenchHostProvider, { runtime },
            createElement(WorkbenchLocalizationProvider, { value: localization }, createElement(Diagnostics))))
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'empty' },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="app"></div><ul id="requests"></ul><ul id="notifications"></ul>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })

    const requests = page.locator('#requests li')
    const notices = page.locator('#notifications li')
    await expect(requests).toHaveText(['/first/App.vue', '/first/style.css'])
    await expect(notices).toHaveText(['Vue language server unavailable'])

    for (const expectedCount of [4, 6]) {
      await page.getByRole('button', { name: 'Refresh' }).click()
      await expect(requests).toHaveCount(expectedCount)
      await expect(requests).toContainText(['/first/App.vue', '/first/style.css'])
      await expect(notices).toHaveText(['Vue language server unavailable'])
    }

    await page.getByRole('button', { name: 'Switch workspace' }).click()
    await expect(requests).toContainText(['/second/App.vue', '/second/style.css'])
    await expect(notices).toHaveText([
      'Vue language server unavailable',
      'Vue language server unavailable',
    ])
  } finally {
    await browser.close()
  }
}, 20_000)
