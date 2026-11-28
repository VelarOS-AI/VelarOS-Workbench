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
import {EditorView, closeHoverTooltips, drawSelection, tooltips} from '@codemirror/view';
import {createWorkbenchLanguageServiceHoverTooltip} from '/src/renderer/src/models/editor/workbenchCodeMirrorLanguageFeatures.ts';
import {workbenchDefinitionHoverExtension} from '/src/renderer/src/models/editor/workbenchCodeMirrorDefinitionHover.ts';
import {createWorkbenchTokenOccurrenceHighlightExtension} from '/src/renderer/src/models/editor/workbenchCodeMirrorTokenOccurrenceHighlight.ts';
import {workbenchEditorLanguageFeatureClasses as classes} from '/src/renderer/src/components/editor/workbenchEditorLanguageFeatureClasses.ts';
const signature='function structuredClone<{\\n'+Array.from({length:55},(_,i)=>'    property'+i+': number;').join('\\n')+'\\n}>(value: Value): Value';
window.highlightRequests=[];
const hostRuntime={kernel:{project:{getWorkbenchLanguageServiceHover:async()=>{
 await new Promise(resolve=>window.resolveHover=resolve);
 return {ok:true,data:{hover:{displayText:signature,...(window.withDocs?{documentation:'Clone the supplied value.'}:{})}}};
}}}};
const editor=document.querySelector('#editor');
window.view=new EditorView({parent:editor,state:EditorState.create({
 doc:'structuredClone(value)\\nconst item = value\\n'+' '.repeat(86)+'nearBoundary\\n'+Array.from({length:398},()=> 'const item = value').join('\\n'),
 extensions:[EditorView.theme({'&':{height:'600px'},'.cm-scroller':{overflow:'auto'}}),drawSelection(),
 tooltips({parent:editor,position:'absolute',tooltipSpace:()=>{
   const {top,right,bottom,left}=editor.getBoundingClientRect();
   return {top:top+8,right:right-8,bottom:bottom-8,left:left+8};
 }}),
 workbenchDefinitionHoverExtension,
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
                '<html><body class="wb_root"><div id="editor" class="wb_codeMirrorEditor" style="width:800px;height:600px;--workbench-editor-font-size:12.5px;--workbench-editor-line-height:22px"></div><script type="module" src="/__interaction.js"></script></body></html>'
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
  await page.evaluate(() => {
    const editor = document.querySelector('#editor')
    editor.addEventListener('mousemove', () => { window.hoverStartedAt = performance.now() }, { once: true })
    const observer = new MutationObserver(() => {
      if (typeof window.hoverStartedAt !== 'number' || !editor.querySelector('.wb_editorSymbolTooltip')) return
      window.firstHoverDelay = performance.now() - window.hoverStartedAt
      observer.disconnect()
    })
    observer.observe(editor, { childList: true, subtree: true })
  })
  await firstLine.hover({ position: { x: 40, y: 8 } })
  const tooltip = page.locator('.wb_editorSymbolTooltip')
  await expect
    .poll(() => page.evaluate(() => typeof window.resolveHover), { timeout: 1000 })
    .toBe('function')
  await expect(tooltip).toHaveCount(0)
  await page.evaluate(() => window.resolveHover())
  await page.waitForTimeout(500)
  await expect(tooltip).toHaveCount(0)
  await expect(tooltip).toHaveAttribute('data-layout', 'single-code')
  assert.ok(await page.evaluate(() => window.firstHoverDelay >= 1180))
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
    window.resolveHover = undefined
    window.closeHover()
  })
  await page.mouse.move(900, 600)
  await page.waitForTimeout(30)
  await firstLine.hover({ position: { x: 45, y: 8 } })
  await expect
    .poll(() => page.evaluate(() => typeof window.resolveHover), { timeout: 1000 })
    .toBe('function')
  await expect(tooltip).toHaveCount(0)
  await page.evaluate(() => window.resolveHover())
  await expect(tooltip).toContainText('Clone the supplied value.')
  await expect(tooltip).not.toHaveAttribute('data-layout', 'single-code')
  const width = await tooltip.evaluate((element) => ({
    available: element.clientWidth - 24,
    code: element.firstElementChild.getBoundingClientRect().width,
  }))
  assert.ok(Math.abs(width.available - width.code) <= 2, JSON.stringify(width))
  console.info('PASS documented signatures fill the available tooltip width')

  await firstLine.dblclick({ position: { x: 40, y: 8 } })
  await expect(tooltip).toHaveCount(0)
  await page.waitForTimeout(1600)
  await expect(tooltip).toHaveCount(0)

  const boundaryPoint = await page.evaluate(() => {
    window.view.dispatch({ selection: { anchor: 0 } })
    window.resolveHover = undefined
    const position = window.view.state.doc.line(3).to - 8
    const rect = window.view.coordsAtPos(position)
    const x = rect.left + 1
    const y = (rect.top + rect.bottom) / 2
    return { x, y, text: document.elementFromPoint(x, y)?.closest('.cm-line')?.textContent?.trim() }
  })
  assert.equal(boundaryPoint.text, 'nearBoundary', JSON.stringify(boundaryPoint))
  await page.mouse.move(boundaryPoint.x, boundaryPoint.y)
  await expect
    .poll(() => page.evaluate(() => typeof window.resolveHover), { timeout: 1000 })
    .toBe('function')
  const hoverFrames = await page.evaluate(async () => {
    const frames = []
    const editorBounds = document.querySelector('#editor').getBoundingClientRect()
    const deadline = performance.now() + 4000
    window.resolveHover()
    while (frames.length < 6 && performance.now() < deadline) {
      await new Promise(requestAnimationFrame)
      const surface = document.querySelector('.cm-tooltip-hover')
      if (!surface || getComputedStyle(surface).visibility === 'hidden') continue
      const bounds = surface.getBoundingClientRect()
      if (bounds.bottom <= editorBounds.top || bounds.top >= editorBounds.bottom) continue
      frames.push({ left: bounds.left, right: bounds.right, boundary: editorBounds.right })
    }
    return frames
  })
  assert.equal(hoverFrames.length, 6)
  for (const frame of hoverFrames) {
    assert.ok(frame.left < boundaryPoint.x && frame.right <= frame.boundary)
    assert.ok(Math.abs(hoverFrames[0].left - frame.left) <= 1, JSON.stringify(hoverFrames))
  }
  console.info('PASS right-edge hover starts inside the editor without moving across frames')

  await page.evaluate(() => {
    window.closeHover()
    window.view.focus()
    window.view.dispatch({ selection: { anchor: 18 } })
  })
  await page.waitForTimeout(250)
  const occurrence = page.locator('.cm-workbenchTokenOccurrence').first()
  const occurrenceBox = await occurrence.boundingBox()
  const caret = await page.locator('.cm-cursor').first().boundingBox()
  assert.ok(occurrenceBox && caret && Math.abs(occurrenceBox.height - caret.height) <= 1)
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
  assert.equal(await page.evaluate(() => window.highlightRequests.length), 0)
  await expect.poll(() => page.evaluate(() => window.highlightRequests.length)).toBe(1)
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
