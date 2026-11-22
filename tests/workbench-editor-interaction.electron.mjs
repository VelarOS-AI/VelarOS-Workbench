// Native regression: node tests/workbench-editor-interaction.electron.mjs --show-window
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import { createServer } from 'vite'

import { manualElectronTestArgs } from './helpers/manualElectronTest.mjs'

manualElectronTestArgs()

const root = process.cwd()
const temporary = await mkdtemp(path.join(tmpdir(), 'wb-editor-interaction-'))
const output = path.resolve('artifacts/editor-smoothness')
await mkdir(output, { recursive: true })
const entry = `
import '/src/renderer/src/styles/globalStyles.ts';
import {EditorState} from '@codemirror/state';
import {EditorView, closeHoverTooltips} from '@codemirror/view';
import {createWorkbenchLanguageServiceHoverTooltip} from '/src/renderer/src/models/editor/workbenchCodeMirrorLanguageFeatures.ts';
import {createWorkbenchTokenOccurrenceHighlightExtension} from '/src/renderer/src/models/editor/workbenchCodeMirrorTokenOccurrenceHighlight.ts';
import {workbenchEditorLanguageFeatureClasses as classes} from '/src/renderer/src/components/editor/workbenchEditorLanguageFeatureClasses.ts';
const signature='function structuredClone<{\\n'+Array.from({length:55},(_,i)=>'    property'+i+': number;').join('\\n')+'\\n}>(value: Value): Value';
window.highlightRequests=[];
const hostRuntime={kernel:{project:{getWorkbenchLanguageServiceHover:async()=>{
 await new Promise(resolve=>window.resolveHover=resolve);
 return {ok:true,data:{hover:{displayText:signature,...(window.withDocs?{documentation:'Clone the supplied value.'}:{})}}};
}}}};
window.view=new EditorView({parent:document.querySelector('#editor'),state:EditorState.create({
 doc:'structuredClone(value)\\n'+Array.from({length:400},()=> 'const item = value').join('\\n'),
 extensions:[EditorView.theme({'&':{height:'600px'},'.cm-scroller':{overflow:'auto'}}),
 createWorkbenchLanguageServiceHoverTooltip({projectRoot:'/fixture',path:'main.ts',language:'TypeScript',getOpenTabs:()=>[],hostRuntime},classes),
 createWorkbenchTokenOccurrenceHighlightExtension({request:async(content,position)=>{
   window.highlightRequests.push(position); return [{range:{startLine:1,startColumn:17,endLine:1,endColumn:22},kind:'read'}];
 }})]
})});
window.closeHover=()=>window.view.dispatch({effects:closeHoverTooltips});
`
let server
let app
try {
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'editor-interaction-fixture',
        resolveId(id) {
          if (id === '/__interaction.js') return '\0interaction.js'
        },
        load(id) {
          if (id === '\0interaction.js') return entry
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url !== '/__interaction') return next()
            res.setHeader('Content-Type', 'text/html')
            res.end(
              await server.transformIndexHtml(
                '/__interaction',
                '<html><body class="wb_root"><div id="editor" class="wb_codeMirrorEditor" style="width:800px"></div><script type="module" src="/__interaction.js"></script></body></html>'
              )
            )
          })
        },
      },
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@renderer': path.join(root, 'src/renderer/src'),
        '@shared': path.join(root, 'src/shared'),
      },
    },
    css: { modules: { generateScopedName: 'wb_[local]' } },
    server: { host: '127.0.0.1', port: 0, watch: null },
  })
  await server.listen()
  const main = path.join(temporary, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:740,show:true});w.loadURL(${JSON.stringify(`${server.resolvedUrls.local[0]}__interaction`)});});`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [main],
    env,
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.locator('.cm-content')).toContainText('structuredClone', { timeout: 60_000 })
  await page.bringToFront()
  const firstLine = page.locator('.cm-line').first()
  await firstLine.hover({ position: { x: 40, y: 8 } })
  const tooltip = page.locator('.wb_editorSymbolTooltip')
  await expect(tooltip.getByRole('status')).toBeVisible()
  await page.evaluate(() => window.resolveHover())
  await expect(tooltip).toHaveAttribute('data-layout', 'single-code')
  await expect(tooltip).toContainText('property54')
  const dimensions = await tooltip.evaluate((element) => {
    const code = element.querySelector('.wb_editorSymbolTooltipTitle')
    return {
      outer: element.getBoundingClientRect().width,
      inner: code.getBoundingClientRect().width,
      height: code.clientHeight,
      content: code.scrollHeight,
    }
  })
  assert.ok(Math.abs(dimensions.outer - dimensions.inner) <= 2, JSON.stringify(dimensions))
  assert.ok(
    dimensions.content > dimensions.height && dimensions.height <= 420,
    JSON.stringify(dimensions)
  )
  const screenshot = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayAwake: true })
    ).toDataURL()
  )
  await writeFile(
    path.join(output, 'hover-verified.png'),
    Buffer.from(screenshot.split(',')[1], 'base64')
  )
  console.info('PASS delayed hover retains full-width single-code layout and bounded scrolling')

  await page.evaluate(() => {
    window.withDocs = true
    window.closeHover()
  })
  await page.mouse.move(900, 600)
  await firstLine.hover({ position: { x: 40, y: 8 } })
  await expect(tooltip.getByRole('status')).toBeVisible()
  await page.evaluate(() => window.resolveHover())
  await expect(tooltip).toContainText('Clone the supplied value.')
  await expect(tooltip).not.toHaveAttribute('data-layout', 'single-code')
  const width = await tooltip.evaluate((element) => ({
    available: element.clientWidth - 24,
    code: element.firstElementChild.getBoundingClientRect().width,
  }))
  assert.ok(Math.abs(width.available - width.code) <= 2, JSON.stringify(width))
  console.info('PASS documented signatures fill the available tooltip width')

  await page.evaluate(() => {
    window.closeHover()
    window.view.focus()
    window.view.dispatch({ selection: { anchor: 18 } })
  })
  await page.waitForTimeout(250)
  const count = await page.evaluate(() => window.highlightRequests.length)
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      window.view.scrollDOM.scrollTop += 80
    })
    await page.waitForTimeout(35)
  }
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => window.highlightRequests.length), count)
  console.info('PASS scrolling preserves semantic occurrences without more language requests')

  await page.evaluate(() => {
    window.view.dispatch({ selection: { anchor: window.view.state.doc.line(2).from + 14 } })
  })
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => window.highlightRequests.at(-1).line), 2)
  console.info('PASS moving to the same word in another scope refreshes semantic occurrences')
  await page.evaluate(() => {
    window.highlightRequests.length = 0
  })
  await page.keyboard.type('performanceTyping', { delay: 20 })
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => window.highlightRequests.length), 1)
  await page.evaluate(() => {
    window.view.dispatch({ changes: { from: 0, insert: 'x' } })
    window.view.destroy()
  })
  await page.waitForTimeout(200)
  assert.deepEqual(errors, [])
  console.info(
    'PASS continuous typing coalesces semantic requests and closing cancels pending work'
  )
} finally {
  await app?.close()
  await server?.close()
}
