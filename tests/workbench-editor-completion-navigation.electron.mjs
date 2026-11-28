// Native regression: node tests/workbench-editor-completion-navigation.electron.mjs --show-window <application.exe>
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'

import { manualElectronTestArgs } from './helpers/manualElectronTest.mjs'

const [packagedApplication] = manualElectronTestArgs()
assert.ok(packagedApplication, 'Pass the native packaged application executable')
const temporary = await mkdtemp(path.join(tmpdir(), 'wb-completion-navigation-'))
const project = path.join(temporary, 'project')
await mkdir(project)
await writeFile(
  path.join(project, 'main.js'),
  ['let demoNumber = 3', 'let demoString = "hello"', 'let demoBoolean = true', ''].join('\n')
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.NODE_OPTIONS
const app = await electron.launch({
  executablePath: path.resolve(packagedApplication),
  args: [`--user-data-dir=${path.join(temporary, 'profile')}`, project],
  cwd: temporary,
  env,
})
try {
  const page = await app.firstWindow()
  await page.bringToFront()
  await page.getByText('main.js', { exact: true }).first().dblclick({ timeout: 30_000 })
  const content = page.locator('.cm-content')
  await expect(content).toContainText('demoBoolean')
  await content.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('demo')

  const menu = page.locator('.cm-tooltip-autocomplete')
  const selected = menu.locator('[aria-selected="true"] .cm-completionLabel')
  const signature = menu.locator('.cm-workbenchCompletionSignature')
  await expect(selected).toBeVisible()
  const caret = () => content.evaluate((node) => node.cmTile.root.view.state.selection.main.head)
  const caretBeforeNavigation = await caret()
  const first = await selected.innerText()
  await page.keyboard.press('ArrowDown')
  await expect(selected).not.toHaveText(first)
  const second = await selected.innerText()
  await expect(signature).toContainText(second)
  await page.keyboard.press('ArrowUp')
  await expect(selected).toHaveText(first)
  await expect(signature).toContainText(first)

  const pointerTarget = menu.getByRole('option', { name: /demoString/u })
  await expect(pointerTarget).toHaveCount(1)
  assert.notEqual(first, 'demoString')
  await pointerTarget.hover()
  await expect(selected).toHaveText('demoString')
  await expect(signature).toContainText('demoString')
  await page.keyboard.press('ArrowUp')
  await expect(selected).not.toHaveText('demoString')
  await expect(signature).toContainText(await selected.innerText())
  assert.equal(await caret(), caretBeforeNavigation)
  await pointerTarget.click()
  await expect(menu).toHaveCount(0)
  const lastLine = await content.evaluate((node) => {
    const { doc } = node.cmTile.root.view.state
    return doc.line(doc.lines).text
  })
  assert.equal(lastLine, 'demoString')
  console.info(
    'PASS keyboard and pointer change the completion and its signature without moving the caret'
  )

  await page.evaluate(() => {
    const settings = { preset: 'vim', overrides: {} }
    localStorage.setItem('velaros.workbench.keymap.v2', JSON.stringify(settings))
    window.dispatchEvent(new CustomEvent('velaros:workbench-keymap-changed', { detail: settings }))
  })
  await expect(page.locator('.cm-vimCursorLayer')).toHaveCount(1)
  await content.focus()
  await page.keyboard.press('o')
  await page.keyboard.type('demo')
  await expect(selected).toBeVisible()
  const vimFirst = await selected.innerText()
  const vimCaret = await caret()
  await page.keyboard.press('ArrowDown')
  await expect(selected).not.toHaveText(vimFirst)
  await page.keyboard.press('ArrowUp')
  await expect(selected).toHaveText(vimFirst)
  assert.equal(await caret(), vimCaret)
  console.info('PASS completion arrow navigation takes priority in Vim insert mode')
} finally {
  await app.close()
}
