import { chromium, expect } from '@playwright/test'
import { afterAll, test } from 'bun:test'
import { build, stop } from 'esbuild'

afterAll(() => stop())

test('the task-usage button uses Desktop cache coverage for the current task', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createElement } from 'react'
        import { createRoot } from 'react-dom/client'
        import { WorkbenchUsageSummary } from './src/renderer/src/runtime/conversation/WorkbenchUsageSummary'
        import { WorkbenchLocalizationProvider } from './src/renderer/src/i18n/WorkbenchLocalizationProvider'
        import { readStandaloneUsageTelemetry } from './src/renderer/src/runtime/standaloneUsageTelemetry'

        const read = (overrides) => readStandaloneUsageTelemetry({
          kind: 'usage-telemetry',
          model: 'test-model',
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 80,
          timestamp: 20,
          ...overrides,
        })
        const entries = [
          read({ requestId: 'previous', timestamp: 1, cacheReadInputTokens: 0 }),
          read({ requestId: 'context:legacy', cacheReadInputTokens: 0 }),
          read({ requestId: 'context-summary', scope: 'auxiliary', cacheReadInputTokens: 0 }),
          read({ requestId: 'task-model' }),
        ]
        createRoot(document.querySelector('#app')).render(createElement(
          WorkbenchLocalizationProvider,
          { value: { locale: 'en-US', t: key => key, setLocale: async () => {} } },
          createElement(WorkbenchUsageSummary, { entries, startedAt: 10 }),
        ))
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'empty', '.module.css': 'empty', '.svg': 'dataurl' },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="app" style="padding:100px"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.getByRole('button', { name: 'Task usage' }).hover()
    const popover = page.locator('section[aria-label="Task usage"]')
    await expect(popover).toContainText('Cache hit')
    await expect(popover).toContainText('80.0%')
    await expect(popover).toContainText('Requests 1')
  } finally {
    await browser.close()
  }
}, 20_000)
