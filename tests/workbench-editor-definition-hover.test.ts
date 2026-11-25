import { chromium, expect } from '@playwright/test'
import { afterAll, test } from 'bun:test'
import { build, stop } from 'esbuild'

afterAll(() => stop())

test('returning from a definition clears its underline and waits for fresh hover', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { EditorState } from '@codemirror/state'
        import { activateHover, EditorView } from '@codemirror/view'
        import { workbenchEditorLanguageFeatureClasses as classes } from './src/renderer/src/components/editor/workbenchEditorLanguageFeatureClasses'
        import {
          clearWorkbenchEditorHover, resumeWorkbenchEditorHover, setWorkbenchDefinitionHoverRange,
          workbenchDefinitionHoverExtension,
        } from './src/renderer/src/models/editor/workbenchCodeMirrorDefinitionHover'
        import { createWorkbenchLanguageServiceHoverTooltip } from './src/renderer/src/models/editor/workbenchCodeMirrorLanguageFeatures'

        let requests = 0
        let finishFirstHover
        const hoverResult = { ok: true, data: { hover: { kind: 'function', displayText: 'function greet(): string' } } }
        const hostRuntime = { kernel: { project: {
          getWorkbenchLanguageServiceHover() {
            if (++requests === 1) return new Promise(resolve => { finishFirstHover = resolve })
            return Promise.resolve(hoverResult)
          },
        } } }
        const extensions = [
          workbenchDefinitionHoverExtension,
          createWorkbenchLanguageServiceHoverTooltip({ projectRoot: '/project', path: 'main.ts',
            language: 'TypeScript', getOpenTabs: () => [], hostRuntime }, classes),
        ]
        const view = new EditorView({ parent: document.querySelector('#editor'),
          state: EditorState.create({ doc: 'greet()', extensions }) })
        view.dispatch({ effects: setWorkbenchDefinitionHoverRange.of({ from: 0, to: 5 }) })
        activateHover(view, 2, 1)
        window.returnToSource = () => {
          clearWorkbenchEditorHover(view)
          const original = view.state
          view.setState(EditorState.create({ doc: 'function greet() {}', extensions }))
          view.setState(original)
          finishFirstHover(hoverResult)
          activateHover(view, 2, 1)
        }
        window.hoverAgain = () => {
          resumeWorkbenchEditorHover(view)
          activateHover(view, 2, 1)
        }
        window.hoverRequests = () => requests
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
    await page.setContent('<div id="editor"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await expect(page.locator('.cm-workbenchDefinitionHoverLink')).toHaveText('greet')
    await page.evaluate('returnToSource()')
    await expect(page.locator('.cm-workbenchDefinitionHoverLink')).toHaveCount(0)
    await expect.poll(() => page.evaluate('hoverRequests()')).toBe(1)
    await expect(page.locator('.cm-tooltip-hover')).toHaveCount(0)
    await page.evaluate('hoverAgain()')
    await expect(page.locator('.cm-tooltip-hover')).toContainText('greet')
  } finally {
    await browser.close()
  }
}, 15_000)
