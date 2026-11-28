// Native package smoke test: node tests/workbench-editor-behavior.electron.mjs --show-window <application.exe>
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'

import { manualElectronTestArgs } from './helpers/manualElectronTest.mjs'

const nativeTestArgs = manualElectronTestArgs()

const executablePath = nativeTestArgs[0]
assert.ok(executablePath, 'Pass the native packaged application executable')
const temporary = await mkdtemp(path.join(tmpdir(), 'wb-editor-package-'))
const profile = path.join(temporary, 'profile')
const projectRoot = path.join(temporary, 'project')
await mkdir(projectRoot)
const content =
  'import { greet } from "./helper"\nconst message = greet("World")\nconsole.log(message)\n'
const vueContent =
  '<script setup lang="ts">\nfunction formatDate(value: Date): string { return value.toISOString() }\nconst values = Array.from(new Map([["a", new Date()]]).values()).map(formatDate)\nconst count: number = "wrong"\n</script>\n<template><div>{{ values }} {{ count }}</div></template>\n'
const longLine = `const horizontal = [${'0, '.repeat(420)}765432101];\n${'\n'.repeat(100)}const bottom = "scrolled into view";\n`
await Promise.all([
  writeFile(path.join(projectRoot, 'main.ts'), content),
  writeFile(
    path.join(projectRoot, 'helper.ts'),
    '/** Build a greeting. */\nexport function greet(name: string): string { return `Hello ${name}` }\n'
  ),
  writeFile(path.join(projectRoot, 'Main.java'), 'public class Main {}\n'),
  writeFile(path.join(projectRoot, 'main.py'), 'print("Hello")\n'),
  writeFile(path.join(projectRoot, 'App.vue'), vueContent),
  writeFile(path.join(projectRoot, 'longline.ts'), longLine),
  writeFile(path.join(projectRoot, 'package.json'), '{"type":"module"}'),
  writeFile(
    path.join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        lib: ['ES2022', 'DOM'],
      },
      include: ['*.ts', '*.vue'],
    })
  ),
])
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
const app = await electron.launch({
  executablePath: path.resolve(executablePath),
  args: [`--user-data-dir=${profile}`, projectRoot],
  cwd: temporary,
  env,
  timeout: 30_000,
})
const errors = []
try {
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.getPath('userData')), profile)
  const page = await app.firstWindow()
  await page.bringToFront()
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  await page.getByText('main.ts', { exact: true }).first().dblclick({ timeout: 30_000 })
  await expect(page.locator('.cm-content')).toContainText('console.log')
  const cursorLayer = page.locator('.cm-editor .cm-cursorLayer')
  await expect(cursorLayer).toHaveCSS('visibility', 'hidden')
  await page.locator('.cm-content').focus()
  await page.keyboard.press('ArrowRight')
  await expect(cursorLayer).toHaveCSS('visibility', 'visible')
  await expect(page.locator('.cm-editor .cm-activeLine')).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('footer')).toContainText('第 2 行')
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('footer')).toContainText('第 1 行')
  console.info('PASS a newly opened editor reveals its cursor on the first keyboard action')
  const diagnostics = await page.evaluate(
    (request) => window.velarosWorkbenchLanguage.getDiagnostics(request),
    {
      projectRoot,
      path: 'main.ts',
      language: 'typescript',
      content,
    }
  )
  assert.ok(diagnostics.ok, JSON.stringify(diagnostics))
  assert.deepEqual(
    diagnostics.value.diagnostics,
    [],
    'The packaged standard library must resolve console and string'
  )
  console.info('PASS packaged standard library and diagnostics')

  const inferredLine = page.locator('.cm-line').filter({ hasText: 'const message' })
  await expect(inferredLine.locator('.cm-workbenchInlayTypeHint')).toContainText('string')
  const removedInSameEdit = await inferredLine.evaluate((line) => {
    const view = line.closest('.cm-content').cmTile.root.view
    const hint = line.querySelector('.cm-workbenchInlayTypeHint')
    const from = view.state.doc.line(2).from
    const to = view.state.doc.line(3).from
    const removed = view.state.sliceDoc(from, to)
    view.dispatch({ changes: { from, to }, userEvent: 'delete.selection' })
    const detached = !hint.isConnected
    view.dispatch({ changes: { from, insert: removed } })
    return detached
  })
  assert.ok(removedInSameEdit)
  console.info('PASS deleting a declaration removes its inferred type in the same editor update')

  const completions = await page.evaluate(
    (request) => window.velarosWorkbenchLanguage.getCompletions(request),
    {
      projectRoot,
      path: 'main.ts',
      language: 'typescript',
      content,
      position: { line: 3, column: 9 },
    }
  )
  assert.ok(
    completions.ok && completions.value.items.some((item) => item.label === 'log'),
    JSON.stringify(completions)
  )
  console.info('PASS console member completions')

  const identifier = page.locator('.cm-content').getByText('greet', { exact: true }).last()
  await page.bringToFront()
  await identifier.hover()
  await expect(page.locator('.cm-tooltip-hover')).toContainText('greet', { timeout: 15_000 })
  console.info('PASS symbol hover tooltip')
  await app.evaluate(async ({ BrowserWindow }) => {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const other = new BrowserWindow({ width: 180, height: 100, show: false })
    other.show()
    other.focus()
    await new Promise((resolve) => setTimeout(resolve, 200))
    other.destroy()
    owner.focus()
  })
  await page.bringToFront()
  await page.mouse.move(0, 0)
  await identifier.hover()
  await expect(page.locator('.cm-tooltip-hover')).toContainText('greet', { timeout: 2000 })
  console.info('PASS symbol hover after native window focus returns')
  await page.keyboard.down('Control')
  const identifierBox = await identifier.boundingBox()
  assert.ok(identifierBox)
  await page.mouse.move(identifierBox.x + identifierBox.width / 2 + 1, identifierBox.y + identifierBox.height / 2)
  await expect(page.locator('.cm-workbenchDefinitionHoverLink')).toHaveText('greet')
  await page.mouse.down()
  await page.mouse.up()
  await expect(page.locator('.cm-content')).toContainText('export function greet', {
    timeout: 15_000,
  })
  await page.keyboard.up('Control')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page.locator('.cm-content')).toContainText('console.log')
  await expect(page.locator('.cm-workbenchDefinitionHoverLink')).toHaveCount(0)
  await page.waitForTimeout(600)
  await expect(page.locator('.cm-tooltip-hover')).toHaveCount(0)
  await page.mouse.move(0, 0)
  await identifier.hover()
  await expect(page.locator('.cm-tooltip-hover')).toContainText('greet')
  console.info('PASS Ctrl+click navigation clears hover on return and resumes on pointer motion')

  await page.locator('.wb_editorTab').filter({ hasText: 'main.ts' }).first().click()
  if ((await page.locator('.cm-content[contenteditable="true"]').count()) === 0)
    await page.getByRole('button', { name: /^只读模式|^Read.only mode/ }).click()
  await page.locator('.cm-content[contenteditable="true"]').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\ncons', { delay: 60 })
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('console', { timeout: 5000 })
  console.info('PASS console prefix completions')
  await page.evaluate(() => {
    const content = document.querySelector('.cm-content[contenteditable="true"]')
    content.addEventListener('beforeinput', () => {
      const enteredAt = performance.now()
      window.completionHiddenAtInput = !document.querySelector('.cm-tooltip-autocomplete')
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.cm-tooltip-autocomplete')) return
        window.completionReopenDelay = performance.now() - enteredAt
        observer.disconnect()
      })
      observer.observe(content.closest('.wb_codeMirrorEditor'), { childList: true, subtree: true })
    }, { once: true, capture: true })
  })
  await page.keyboard.type('o')
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('console')
  assert.ok(await page.evaluate(() => window.completionHiddenAtInput && window.completionReopenDelay >= 190))
  console.info('PASS typing closes an open completion popup and starts a new delay')
  for (let index = 0; index < 5; index++) await page.keyboard.down('Backspace')
  await page.keyboard.up('Backspace')
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)
  const lastLineAfterBackspace = await page.locator('.cm-content').evaluate((element) => {
    const { doc } = element.cmTile.root.view.state
    return doc.line(doc.lines).text
  })
  assert.equal(lastLineAfterBackspace, '')
  console.info('PASS holding Backspace clears the active completion and deletes every character')
  await page.keyboard.type('console.', { delay: 60 })
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('log', { timeout: 15_000 })
  console.info('PASS completion popup while typing')
  const selectedOption = page.locator(
    '.cm-tooltip-autocomplete [aria-selected="true"] .cm-completionLabel'
  )
  await expect(selectedOption).toBeVisible()
  const initialOption = await selectedOption.innerText()
  assert.equal(initialOption, 'log')
  await page.keyboard.press('ArrowDown')
  await expect(selectedOption).not.toHaveText(initialOption)
  await page.keyboard.press('ArrowUp')
  await expect(selectedOption).toHaveText(initialOption)
  const option = page.locator('.cm-tooltip-autocomplete [aria-selected="true"]')
  await expect(option).toHaveCSS('display', 'grid')
  assert.match(
    await option.locator('.cm-completionIcon-method').evaluate((node) => getComputedStyle(node).backgroundImage),
    /^url\(/u
  )
  const completionDetails = page.locator('.cm-workbenchCompletionSignature')
  await expect(completionDetails).toBeVisible()
  await expect(completionDetails).toContainText('log')
  const functionToken = completionDetails.locator('[data-hover-part="function"]').filter({ hasText: /^log$/u })
  await expect(functionToken).toHaveCSS('color', 'rgb(160, 75, 0)')
  await page.keyboard.press('Tab')
  await expect(page.locator('.cm-content')).toContainText('console.log()')
  const cursorInsideCall = await page.locator('.cm-content').evaluate((element) => {
    const view = element.cmTile.root.view
    return view.state.sliceDoc(view.state.selection.main.head - 1, view.state.selection.main.head + 1)
  })
  assert.equal(cursorInsideCall, '()')
  await page.keyboard.type('42)')
  await expect(page.locator('.cm-content')).toContainText('console.log(42)')
  await expect(page.locator('.cm-content')).not.toContainText('console.log(42))')
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)
  console.info('PASS completion icons, delayed signatures, selection and Tab acceptance with parentheses')
  await page.locator('.cm-content').evaluate((element) => {
    const view = element.cmTile.root.view
    const end = view.state.doc.length
    const prefix = '\nwhile (true) {\n  '
    view.dispatch({ changes: { from: end, insert: `${prefix}\n}` }, selection: { anchor: end + prefix.length } })
  })
  await page.keyboard.type('break', { delay: 30 })
  await page.waitForTimeout(750)
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)
  console.info('PASS the completed break keyword does not trigger a popup')
  await page.locator('.cm-content').evaluate((element) => {
    const view = element.cmTile.root.view
    for (const text of ['\n// latest ', 'unpublished ', 'snapshot']) {
      view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' })
    }
    const save = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(save)
  })
  await expect.poll(() => readFile(path.join(projectRoot, 'main.ts'), 'utf8')).toContain('// latest unpublished snapshot')
  await expect(page.getByText(/文件已保存|^File saved$/u)).toHaveCount(0)
  console.info('PASS saving immediately includes recent typing before the workbench snapshot publishes')
  await page.locator('.cm-content').evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      changes: { from: view.state.doc.length, insert: '\n// autosaved latest draft' },
      userEvent: 'input.type',
    })
  })
  await expect.poll(() => readFile(path.join(projectRoot, 'main.ts'), 'utf8'), { timeout: 10000 }).toContain('// autosaved latest draft')
  await expect(page.getByText(/文件已保存|^File saved$/u)).toHaveCount(0)
  console.info('PASS autosave writes the edited file silently')
  const settings = page
    .getByRole('complementary', { name: '右侧工具窗口' })
    .getByRole('button')
    .first()
  await expect(settings).toHaveAccessibleName('设置')
  await page.keyboard.press('Escape')
  await settings.hover()
  await page.waitForTimeout(300)
  await expect(
    page.locator('[data-slot="tooltip-content"]').filter({ hasText: '设置' })
  ).toHaveCount(0)
  await expect(settings).not.toHaveAttribute('title', /.+/)
  console.info('PASS Settings action has no hover bubble or native tooltip')
  for (const kind of ['java', 'python', 'vue']) {
    const icon = page.locator(`[data-tree-icon="file-${kind}"]`).first()
    await expect(icon).toBeVisible()
    await expect.poll(() => icon.evaluate((node) => node.naturalWidth)).toBeGreaterThan(0)
  }
  const vueRequest = { projectRoot, path: 'App.vue', language: 'Vue', content: vueContent }
  const vueDiagnostics = await page.evaluate(
    (request) => window.velarosWorkbenchLanguage.getDiagnostics(request),
    vueRequest
  )
  assert.ok(vueDiagnostics.ok, JSON.stringify(vueDiagnostics))
  assert.ok(vueDiagnostics.value.diagnostics.some((item) => Number(item.code) === 2322))
  assert.ok(
    !vueDiagnostics.value.diagnostics.some((item) =>
      /Cannot find name '(?:Array|Date|Map)'/.test(item.message)
    )
  )
  const hoverRequest = { ...vueRequest, position: { line: 2, column: 12 } }
  await page.evaluate((request) => window.velarosWorkbenchLanguage.getHover(request), hoverRequest)
  const hoverStart = performance.now()
  const vueHover = await page.evaluate(
    (request) => window.velarosWorkbenchLanguage.getHover(request),
    hoverRequest
  )
  const hoverMs = performance.now() - hoverStart
  assert.ok(
    vueHover.ok && vueHover.value.hover?.displayText.includes('formatDate'),
    JSON.stringify(vueHover)
  )
  assert.ok(
    hoverMs < 1500,
    `Warm Vue hover took ${Math.round(hoverMs)}ms; the server must be reused`
  )
  console.info(`PASS packaged Vue SDK and server reuse: warm hover ${Math.round(hoverMs)}ms`)
  await page.getByText('App.vue', { exact: true }).first().dblclick()
  await expect(page.locator('.cm-content')).toContainText('function formatDate')
  await expect(page.locator('.cm-lintRange-error').first()).toBeVisible({ timeout: 3000 })
  await page.locator('.cm-content').getByText('formatDate', { exact: true }).first().hover()
  await expect(page.locator('.cm-tooltip-hover')).toContainText('formatDate', { timeout: 2000 })
  console.info('PASS Vue inline markers and function hover without waiting for quick fixes')
  await page.getByText('longline.ts', { exact: true }).first().dblclick()
  const longEditor = page.locator('.cm-content')
  await expect(longEditor).toContainText('765432101')
  await expect(longEditor.locator('span').filter({ hasText: /^const$/u })).toBeVisible()
  const endToken = longEditor.locator('span').filter({ hasText: /^765432101$/u })
  await expect(endToken).toHaveCount(0)
  await longEditor.focus()
  await page.keyboard.press('End')
  await expect.poll(() => longEditor.evaluate((element) =>
    element.cmTile.root.view.scrollDOM.scrollLeft
  )).toBeGreaterThan(0)
  await expect(endToken).toBeVisible()
  await expect(endToken).toHaveCSS('color', 'rgb(23, 80, 235)')
  console.info('PASS horizontal scrolling colors a long line as its text enters the viewport')

  await page.keyboard.press('Control+End')
  await expect(longEditor.locator('span').filter({ hasText: /^"scrolled into view"$/u })).toHaveCSS(
    'color',
    'rgb(6, 125, 23)'
  )
  await page.keyboard.insertText('let edited = "new value";')
  const editedLine = longEditor.locator('.cm-line').filter({ hasText: 'let edited' })
  const keyword = editedLine.locator('span').filter({ hasText: /^let$/u })
  const string = editedLine.locator('span').filter({ hasText: /^"new value"$/u })
  await expect(keyword).toHaveCSS('color', 'rgb(0, 51, 179)')
  await expect(string).toHaveCSS('color', 'rgb(6, 125, 23)')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.insertText('let edited = 233;')
  await expect(editedLine.locator('span').filter({ hasText: /^233$/u })).toHaveCSS(
    'color',
    'rgb(23, 80, 235)'
  )
  console.info('PASS syntax colors refresh after entering and replacing code below a long line')
  assert.deepEqual(errors, [])
  const output = path.resolve('artifacts/editor-regression')
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'verified-package.png') })
  console.info('PASS settings position, language icons, and renderer error check')
} finally {
  await app.close()
}
