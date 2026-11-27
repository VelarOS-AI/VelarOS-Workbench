import { chromium, expect } from '@playwright/test'
import { afterAll, test } from 'bun:test'
import { build, stop } from 'esbuild'

afterAll(() => stop())

test('a folder toggles on one click and opening search does not remount the file tree', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createElement, useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { FilePanel } from './src/renderer/src/components/files/FilePanel'
        import { useWorkbenchProjectSearchPanel } from './src/renderer/src/hooks/useWorkbenchProjectSearchPanel'
        import { installWorkbenchHost } from './src/renderer/src/host/WorkbenchHost'
        import { WorkbenchLocalizationProvider } from './src/renderer/src/i18n/WorkbenchLocalizationProvider'

        const root = { path: 'src', name: 'src', type: 'directory', hasChildren: true }
        const child = { path: 'src/main.ts', name: 'main.ts', type: 'file', hasChildren: false }
        const childrenByPath = new Map([['src', [child]]])
        const noop = () => {}
        installWorkbenchHost({
          kernel: { project: { onWorkbenchContentSearchProgress: () => noop } },
        })
        function Harness() {
          const [expandedPaths, setExpandedPaths] = useState(new Set())
          const [searchQuery, setSearchQuery] = useState('')
          const projectSearch = useWorkbenchProjectSearchPanel({
            onQueryChange: setSearchQuery,
            onResetQuery: () => setSearchQuery(''),
          })
          return createElement(FilePanel, {
            tree: {
              project: { id: 'audit-project', name: 'Audit', rootPath: '/project' },
              rootEntries: [root],
              childrenByPath,
              expandedPaths,
              gitDecorations: new Map(),
              isLoadingTree: false,
              isMutatingTree: false,
              selectedEntryPath: null,
              revealRevision: 0,
            },
            search: {
              projectSearch, searchQuery, searchActive: false, searchResult: null,
              openTabs: [], replaceOpenTabContents: noop, onOpenMatch: noop,
            },
            handlers: {
              onSelectEntryPath: noop, onCreateEntry: noop, onRenameEntry: noop,
              onDeleteEntries: noop, onUndoDeleteEntries: noop, onMoveEntries: noop,
              onSearchQueryChange: setSearchQuery, onRefreshProject: noop, onOpenSearchEntry: noop,
              onSelectFile: noop, onOpenFile: noop,
              onSetDirectoryOpen(path, open) {
                setExpandedPaths(previous => {
                  const next = new Set(previous)
                  if (open) next.add(path)
                  else next.delete(path)
                  return next
                })
              },
            },
          })
        }
        createRoot(document.querySelector('#app')).render(createElement(
          WorkbenchLocalizationProvider,
          { value: { locale: 'en-US', t: key => key, setLocale: noop } },
          createElement(Harness),
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
    await page.setContent(`
      <style>
        #app aside { width: 400px; height: 460px }
        [data-slot="scroll-area"] > div { min-height: 320px; min-width: 350px }
      </style>
      <div id="app"></div>
    `)
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const arrow = page.locator('[data-tree-path="src"] button[aria-expanded]')
    const file = page.locator('[data-tree-path="src/main.ts"]')
    await expect(arrow).toHaveAttribute('aria-expanded', 'false')
    await arrow.click()
    await expect(arrow).toHaveAttribute('aria-expanded', 'true')
    await expect(file).toHaveCount(1)

    await file.evaluate((element) => element.setAttribute('data-preserved-tree-row', 'true'))
    const search = page.getByRole('button', { name: 'workbench.searchFiles' })
    await search.click()
    await expect(page.locator('input[type="search"]')).toBeFocused()
    await expect(file).toHaveAttribute('data-preserved-tree-row', 'true')
    await search.click()
    await expect(page.locator('input[type="search"]')).toHaveCount(0)
    await expect(file).toHaveAttribute('data-preserved-tree-row', 'true')

    await arrow.click()
    await expect(arrow).toHaveAttribute('aria-expanded', 'false')
    await expect(file).toHaveCount(0)
  } finally {
    await browser.close()
  }
}, 20_000)
