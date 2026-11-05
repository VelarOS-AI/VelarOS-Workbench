// 专项验证：node tests/workbench-title-tabs.electron.mjs（无需构建完整应用）
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import ts from 'typescript'
import { createServer, transformWithEsbuild } from 'vite'

const root = process.cwd()
const require = createRequire(import.meta.url)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-title-tabs-'))
const source = await fs.readFile('src/main/index.ts', 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'getWorkbenchWindowTitle'
)
assert.ok(declaration)
const titleFunction = ts.transpile(declaration.getText(ast), {
  target: ts.ScriptTarget.ES2022,
})
const titleGuard = source.match(
  /window\.on\('page-title-updated', \(event\) => \{\s*event\.preventDefault\(\)\s*\}\)/u
)?.[0]
assert.ok(titleGuard)
const entry = `
import '/src/renderer/src/styles/globalStyles.ts';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {EditorTabBar} from '/src/renderer/src/components/editor/EditorTabBar.tsx';
import {WorkbenchLocalizationProvider} from '/src/renderer/src/i18n/WorkbenchLocalizationProvider.tsx';
import styles from '/src/renderer/src/styles/workbenchPageStyles.ts';
const noop = () => {};
const tab = (path, dirty = false) => ({path, content: dirty ? 'edited' : 'text', file: {projectRoot: '/fixture', path, content: 'text', size: 4, modifiedAt: 1, totalLines: 1, truncated: false, encoding: 'utf8', eol: 'lf'}});
window.closedTabs = []; window.unpinnedTabs = [];
const props = {
 openTabs: [tab('pinned.ts'),tab('inactive.ts',true),tab('active.ts')], pinnedTabCount:1,
 selectedFilePath:'active.ts',selectedFile:null,hasUnsavedChanges:false,canEditSelectedFile:true,isSavingFile:false,dirtyTabCount:1,gitDecorations:new Map(),tabContextMenu:null,
 onOpenTabContextMenu:noop,onRunTabContextAction:noop,onSelectOpenFile:noop,onKeepOpenFile:noop,onPinOpenFile:noop,onUnpinOpenFile:path=>window.unpinnedTabs.push(path),onMoveTabToGroup:noop,
 onCloseOpenFile:path=>window.closedTabs.push(path),onCloseOtherOpenFiles:noop,onCloseAllOpenFiles:noop,onCloseUnmodifiedOpenFiles:noop,onCloseOpenFilesToRight:noop,onRevertOpenFile:noop,onReorderOpenTabs:noop,onSaveAllOpenFiles:noop
};
createRoot(document.getElementById('root')).render(<WorkbenchLocalizationProvider value={{locale:'zh-CN',setLocale:async()=>{},t:key=>key}}><div className={styles.root+' '+styles.workbenchShell}><EditorTabBar {...props}/></div></WorkbenchLocalizationProvider>);
`
let app
let server
let passed = 0
async function check(name, action) {
  await action()
  passed++
  console.info('PASS', name)
}
try {
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'title-tabs-fixture',
        resolveId(id) {
          if (id === '/__title_tabs.tsx') return '\0title-tabs.tsx'
        },
        async load(id) {
          if (id === '\0title-tabs.tsx')
            return (
              await transformWithEsbuild(entry, 'fixture.tsx', {
                loader: 'tsx',
                jsx: 'automatic',
              })
            ).code
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url !== '/__title_tabs') return next()
            res.setHeader('Content-Type', 'text/html')
            res.end(
              await server.transformIndexHtml(
                '/__title_tabs',
                '<html><body><div id="root"></div><script type="module" src="/__title_tabs.tsx"></script></body></html>'
              )
            )
          })
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@renderer': path.join(root, 'src/renderer/src'),
        '@shared': path.join(root, 'src/shared'),
      },
    },
    css: { modules: { generateScopedName: 'wb_[local]' } },
    server: { host: '127.0.0.1', port: 0, watch: null },
  })
  await server.listen()
  const url = `${server.resolvedUrls.local[0]}__title_tabs`
  const main = path.join(temporary, 'main.cjs')
  await fs.writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');\nconst WorkbenchApplicationName='Fallback';\n${titleFunction}\napp.setPath('userData',${JSON.stringify(path.join(temporary, 'profile'))});\napp.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1000,height:700,title:getWorkbenchWindowTitle('initial-project')}); ${titleGuard}; global.setProjectTitle=name=>window.setTitle(getWorkbenchWindowTitle(name)); await window.loadURL(${JSON.stringify(url)});});`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    executablePath: require('electron'),
    args: [main],
    env,
    timeout: 30000,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('PAGE ERROR', error.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('CONSOLE', msg.text())
  })
  await page.reload()
  const tabs = page.locator('.wb_editorTab[data-preview]')
  await expect(tabs).toHaveCount(3, { timeout: 60000 })
  const inactive = tabs.nth(1)
  const close = inactive.locator('.wb_editorTabClose')
  const pin = tabs.nth(0).locator('.wb_editorTabPin')
  await page.mouse.move(950, 650)
  const rect = () => inactive.boundingBox()
  const before = await rect()
  await check('inactive close is hidden, non-pointer-interactive, 18px and circular', async () => {
    await expect(close).toHaveCSS('opacity', '0')
    await expect(close).toHaveCSS('pointer-events', 'none')
    await expect(close).toHaveCSS('width', '18px')
    await expect(close).toHaveCSS('height', '18px')
    await expect(close).toHaveCSS('border-radius', '50%')
  })
  await check('active close and inactive pin remain visible', async () => {
    await expect(tabs.nth(2).locator('.wb_editorTabClose')).toHaveCSS('opacity', '1')
    await expect(pin).toHaveCSS('opacity', '1')
    await expect(pin).toHaveCSS('pointer-events', 'auto')
  })
  await check('hover reveals close without shifting tab layout', async () => {
    await inactive.hover()
    await expect(close).toHaveCSS('opacity', '1')
    await expect(close).toHaveCSS('pointer-events', 'auto')
    assert.deepEqual(await rect(), before)
    await page.mouse.move(950, 650)
    await expect(close).toHaveCSS('opacity', '0')
  })
  await check('keyboard Tab reaches hidden close and Enter invokes correct callback', async () => {
    await inactive.getByRole('tab').focus()
    await expect(close).toHaveCSS('opacity', '1')
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await expect(close).toHaveCSS('opacity', '1')
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.closedTabs), ['inactive.ts'])
    assert.deepEqual(await rect(), before)
  })
  await check('pin click unpins rather than closes', async () => {
    await pin.click()
    assert.deepEqual(await page.evaluate(() => window.unpinnedTabs), ['pinned.ts'])
    assert.deepEqual(await page.evaluate(() => window.closedTabs), ['inactive.ts'])
  })
  await check('dirty state remains independent of hidden close', async () => {
    await page.evaluate(() => document.activeElement.blur())
    await page.mouse.move(950, 650)
    await expect(inactive).toHaveAttribute('data-dirty', 'true')
    await expect(close).toHaveCSS('opacity', '0')
    await expect(inactive.getByRole('tab')).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.closedTabs), ['inactive.ts'])
  })
  await check(
    'native window title stays fixed through project and document title changes',
    async () => {
      if (process.platform !== 'win32') throw new Error('This native title probe requires Windows')
      assert.equal(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()),
        'VelarOS WorkBench'
      )
      for (const name of ['project-b', null]) {
        await app.evaluate((_electron, name) => global.setProjectTitle(name), name)
        assert.equal(
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()),
          'VelarOS WorkBench'
        )
      }
      await page.evaluate(() => (document.title = 'renderer-project-title'))
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
        )
        .toBe('VelarOS WorkBench')
    }
  )
  console.info(
    `${passed} Electron checks passed (real component/styles; isolated title function, not full app).`
  )
} finally {
  if (app) await app.close()
  if (server) await server.close()
  await fs.rm(temporary, { recursive: true, force: true })
}
