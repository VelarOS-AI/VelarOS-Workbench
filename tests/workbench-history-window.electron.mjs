// Native source test: node tests/workbench-history-window.electron.mjs [packaged-application.exe]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'

const root = process.cwd()
const temporary = await mkdtemp(path.join(tmpdir(), 'wb-history-window-'))
const projectRoot = path.join(temporary, 'project')
const output = path.resolve('artifacts/history-window')
await mkdir(path.join(projectRoot, 'src'), { recursive: true })
await mkdir(path.join(temporary, 'hooks'))
await mkdir(output, { recursive: true })
const versions = ['original', 'revised', 'current'].map(
  (value) => `export function greet(name: string): string {\n  return "${value}: " + name\n}\n`
)
await writeFile(path.join(projectRoot, 'src/main.ts'), versions[0])
await writeFile(
  path.join(projectRoot, 'other.ts'),
  'export const otherFile = "leave this file alone"\n'
)
await writeFile(path.join(projectRoot, 'script.js'), 'export const javascriptFile = true\n')
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-c',
      `core.hooksPath=${path.join(temporary, 'hooks')}`,
      '-c',
      'user.name=Workbench Tests',
      '-c',
      'user.email=workbench-tests@example.invalid',
      ...args,
    ],
    { cwd: projectRoot, stdio: 'pipe', windowsHide: true }
  )
git('init')
git('add', '.')
git('commit', '-m', 'Original file')
const env = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_RENDERER_URL']) delete env[key]
const args = [`--user-data-dir=${path.join(temporary, 'profile')}`, projectRoot]
if (!process.argv[2]) args.unshift(root)
const app = await electron.launch({
  executablePath: process.argv[2]
    ? path.resolve(process.argv[2])
    : createRequire(import.meta.url)('electron'),
  args,
  cwd: temporary,
  env,
  timeout: 30000,
})
const errors = []
const observations = []
try {
  let owner
  await expect
    .poll(
      async () => {
        for (const candidate of app.windows()) {
          try {
            const state = await candidate.evaluate(() =>
              window.velarosWorkbenchProjectHub.getState()
            )
            if (state.currentProject?.path === projectRoot) {
              owner = candidate
              return true
            }
          } catch {
            /* A new renderer may not have installed its bridge yet. */
          }
        }
        return false
      },
      { timeout: 30000 }
    )
    .toBe(true)
  const environment = await app.evaluate(({ app }) => ({
    cwd: process.cwd(),
    userData: app.getPath('userData'),
    argv: process.argv,
  }))
  assert.ok(environment.userData.startsWith(temporary), JSON.stringify(environment))
  const ownerWindow = await app.browserWindow(owner)
  owner.on('pageerror', (e) => errors.push(e.message))
  await expect(owner.getByRole('complementary', { name: '右侧工具窗口' })).toBeVisible({
    timeout: 45000,
  })
  for (const content of versions) {
    const saved = await owner.evaluate((request) => window.velarosWorkbenchFs.saveFile(request), {
      projectRoot,
      path: 'src/main.ts',
      content,
    })
    assert.ok(saved.ok, JSON.stringify(saved))
  }
  git('add', '.')
  git('commit', '-m', 'Current file')
  await expect
    .poll(
      async () =>
        (
          await owner.evaluate(
            (projectRoot) =>
              window.velarosWorkbenchFs.listLocalHistory({ projectRoot, path: 'src/main.ts' }),
            projectRoot
          )
        ).value?.entries.length ?? 0
    )
    .toBeGreaterThanOrEqual(3)
  async function openMain() {
    await owner.bringToFront()
    await owner.keyboard.press('Control+p')
    const input = owner.getByRole('combobox')
    await input.fill('src/main.ts')
    await owner.getByRole('option').filter({ hasText: 'main.ts' }).first().click()
    await expect(owner.locator('.cm-content')).toContainText('export function greet')
  }
  await openMain()
  if ((await owner.locator('.cm-content[contenteditable="true"]').count()) === 0)
    await owner.getByRole('button', { name: /^只读模式|^Read.only mode/ }).click()
  async function openHistory() {
    const opened = app.waitForEvent('window')
    await owner.locator('.cm-content').click({ button: 'right', position: { x: 100, y: 12 } })
    await owner.getByRole('menuitem', { name: '本地历史', exact: true }).click()
    const history = await opened
    history.on('pageerror', (e) => errors.push(e.message))
    await expect(history.locator('.wb_fileHistoryRoot')).toBeVisible({ timeout: 15000 })
    return history
  }
  let history = await openHistory()
  for (const kind of ['typescript', 'javascript']) {
    const mark = owner.locator(`[data-file-icon-kind="${kind}"][data-compact-language-mark]`).first()
    const sizes = await mark.evaluate(svg => ({ slot: svg.getBoundingClientRect().width, mark: svg.querySelector('[data-language-mark-paint]').getBoundingClientRect().width }))
    assert.ok(sizes.mark / sizes.slot < 0.89 && sizes.mark / sizes.slot > 0.80, JSON.stringify({kind,...sizes}))
  }
  const activeTab = owner.getByRole('tab', {name:'main.ts',exact:true})
  const iconBox = await activeTab.locator('[data-file-icon-kind="typescript"]').boundingBox()
  const nameBox = await activeTab.locator('.wb_editorTabName').boundingBox()
  assert.ok(Math.abs(nameBox.x - iconBox.x - iconBox.width - 6) < 0.5)
  console.info('PASS JS/TS marks shrink inside the original slots and retain the 6px tab gap')
  const rows = () => history.locator('.wb_historyTimelineRow')
  await expect(rows()).toHaveCount(3)
  await expect(owner.locator('.cm-content')).toContainText('current:')
  await expect(owner.locator('.wb_fileHistoryRoot')).toHaveCount(0)
  assert.ok(
    await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('view=file-history')
      )
      return !!child?.getParentWindow() && child.getParentWindow() !== child
    })
  )
  console.info('PASS context menu opens an owned native window and leaves the editor visible')

  await rows().last().click()
  await expect(history.locator('.cm-content')).toContainText('original:')
  const search = history.getByPlaceholder('按文件内容搜索…')
  await search.fill('revised:')
  await expect(rows()).toHaveCount(1)
  await expect(history.locator('.cm-content')).toContainText('revised:')
  await search.fill('')
  await expect(rows()).toHaveCount(3)
  await rows().last().click()
  await history.getByRole('button', { name: '差异', exact: true }).click()
  await expect(history.locator('.cm-diffLineDel').first()).toContainText('original:')
  await expect(history.locator('.cm-diffLineAdd').first()).toContainText('current:')
  console.info('PASS historical content search and syntax-highlighted comparison')

  for (const theme of ['light-modern', 'dark-modern', 'warm-paper', 'midnight-blue']) {
    await owner.evaluate((theme) => {
      const key = 'velaros.workbench.preferences.v1'
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), theme, accent: 'green' })
      )
      window.dispatchEvent(new Event('velaros:workbench-preferences-changed'))
    }, theme)
    await expect(history.locator('html')).toHaveAttribute('data-workbench-theme', theme)
    await expect(owner.locator('html')).toHaveAttribute('data-workbench-theme', theme)
    const colors = await history.locator('.wb_fileHistoryRoot').evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      ink: getComputedStyle(el).color,
      selected: getComputedStyle(
        document.querySelector('.wb_historyTimelineRow[data-active="true"]')
      ).backgroundColor,
    }))
    assert.equal(
      colors.background,
      await owner.locator('.cm-editor').evaluate((el) => getComputedStyle(el).backgroundColor)
    )
    const image = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('view=file-history'))
          .webContents.capturePage(undefined, { stayAwake: true })
      ).toDataURL()
    )
    await writeFile(
      path.join(output, `history-${theme}.png`),
      Buffer.from(image.split(',')[1], 'base64')
    )
    const icons = await ownerWindow.evaluate(async window => (await window.webContents.capturePage({x:0,y:0,width:420,height:240},{stayAwake:true})).toDataURL())
    await writeFile(path.join(output, `icons-${theme}.png`), Buffer.from(icons.split(',')[1],'base64'))
    observations.push({ theme, ...colors })
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('view=file-history'))
      .setSize(760, 520)
  )
  const bounds = await history.locator('.wb_fileHistoryRoot').evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    viewport: innerWidth,
    body: document.body.scrollWidth,
    height: el.getBoundingClientRect().bottom,
    viewportHeight: innerHeight,
  }))
  assert.ok(
    bounds.width <= bounds.viewport &&
      bounds.body <= bounds.viewport &&
      bounds.height <= bounds.viewportHeight + 1,
    JSON.stringify(bounds)
  )
  console.info('PASS all four editor themes synchronize and the compact window fits its viewport')

  await history.getByRole('button', { name: 'Git 历史', exact: true }).click()
  await expect(rows()).toHaveCount(2)
  await history.getByRole('button', { name: '本地历史', exact: true }).click()
  await expect(rows()).toHaveCount(3)
  await rows().last().click()
  await owner.getByText('other.ts', { exact: true }).first().dblclick()
  await expect(owner.locator('.cm-content')).toContainText('leave this file alone')
  await expect(history.locator('.wb_fileHistoryFileName')).toHaveText('main.ts')
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click()
  await expect.poll(() => history.isClosed()).toBe(true)
  await expect(owner.locator('.cm-content')).toContainText('leave this file alone')
  await openMain()
  await expect(owner.locator('.cm-content')).toContainText('original:')
  console.info('PASS restoring after a tab switch updates only the original file')

  history = await openHistory()
  await expect(rows()).not.toHaveCount(0)
  const state = await history.evaluate(() => window.velarosWorkbenchHistoryWindow.getState())
  await owner.locator('.cm-content').click()
  await owner.keyboard.press('Control+End')
  await owner.keyboard.type('// newer draft')
  const stale = await history.evaluate(
    (state) =>
      window.velarosWorkbenchHistoryWindow.restore({
        id: state.id,
        expectedContent: state.currentContent,
        content: 'must not overwrite the newer draft',
      }),
    state
  )
  assert.deepEqual(stale, { ok: false, reason: 'stale' })
  await expect(owner.locator('.cm-content')).toContainText('newer draft')
  await owner.keyboard.press('Control+s')
  await expect(owner.getByText('已保存', { exact: true })).toBeVisible()
  await owner
    .locator('.wb_editorTab')
    .filter({ hasText: 'main.ts' })
    .locator('.wb_editorTabClose')
    .click()
  await expect(history.getByRole('button', { name: '恢复此版本', exact: true })).toBeDisabled()
  await expect(history.getByRole('status')).toContainText('原文件已关闭')
  await openMain()
  await expect(history.getByRole('button', { name: '恢复此版本', exact: true })).toBeEnabled()
  console.info('PASS stale drafts are protected and closed-file state recovers when reopened')
  await ownerWindow.evaluate((window) => window.destroy())
  await expect.poll(() => history.isClosed()).toBe(true)
  assert.deepEqual(errors, [])
  await writeFile(
    path.join(output, 'native-results.json'),
    JSON.stringify({ themes: observations, errors }, null, 2)
  )
  console.info('PASS history closes with its editor owner; no renderer errors')
} finally {
  await app.close()
}
