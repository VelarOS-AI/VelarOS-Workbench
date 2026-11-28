import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'

import { manualElectronTestArgs } from './helpers/manualElectronTest.mjs'

const nativeTestArgs = manualElectronTestArgs()

// node tests/workbench-settings-native.electron.mjs --show-window <application.exe> [output-directory]
assert.equal(process.platform, 'win32', 'Native Windows caption verification requires Windows')
const output = path.resolve(nativeTestArgs[1] ?? 'artifacts/native-settings')
await fs.mkdir(output, { recursive: true })
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-settings-package-'))
const project = path.join(temp, 'project')
await fs.mkdir(project)
await fs.writeFile(path.join(project, 'index.txt'), 'fixture')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
const app = await electron.launch({
  executablePath: path.resolve(nativeTestArgs[0]),
  args: [`--user-data-dir=${path.join(temp, 'profile')}`, project],
  env,
  cwd: temp,
  timeout: 30000,
})
const results = []
try {
  const version = await app.evaluate(({ app }) => app.getVersion())
  const page = await app.firstWindow()
  await expect(page.getByRole('complementary', { name: '右侧工具窗口' })).toBeVisible({
    timeout: 30000,
  })
  await page.evaluate(() => {
    const key = 'velaros.workbench.preferences.v1'
    const preferences = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...preferences, theme: 'dark-modern' }))
    window.dispatchEvent(new Event('velaros:workbench-preferences-changed'))
  })
  await expect(page.locator('html')).toHaveAttribute('data-workbench-theme', 'dark-modern')
  await app.evaluate(({ app, BrowserWindow }) => {
    globalThis.__captionCalls = []
    app.once('browser-window-created', (_, window) => {
      window.once('show', async () => {
        const firstAppearance = await window.webContents.executeJavaScript(`({
          theme: document.documentElement.dataset.workbenchTheme,
          background: getComputedStyle(document.documentElement).getPropertyValue('--workbench-bg').trim(),
          mounted: Boolean(document.querySelector('#root')?.childElementCount),
        })`)
        globalThis.__settingsFirstAppearance = {
          ...firstAppearance,
          minimizable: window.isMinimizable(),
          maximizable: window.isMaximizable(),
          fullscreenable: window.isFullScreenable(),
        }
      })
    })
    for (const w of BrowserWindow.getAllWindows()) {
      const set = w.setTitleBarOverlay.bind(w)
      w.setTitleBarOverlay = (options) => {
        globalThis.__captionCalls.push({ id: w.id, ...options })
        set(options)
      }
    }
  })
  const nextWindow = app.waitForEvent('window')
  await page
    .getByRole('complementary', { name: '右侧工具窗口' })
    .getByRole('button')
    .first()
    .click()
  const settings = await nextWindow
  await expect(settings.getByRole('heading', { name: '外观', exact: true })).toBeVisible({
    timeout: 15000,
  })
  const darkBackground = await page.locator('html').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--workbench-bg').trim()
  )
  await expect.poll(() => app.evaluate(() => globalThis.__settingsFirstAppearance)).toEqual({
    theme: 'dark-modern',
    background: darkBackground,
    mounted: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
  })
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.__observed) continue
      w.__observed = true
      const set = w.setTitleBarOverlay.bind(w)
      w.setTitleBarOverlay = (options) => {
        globalThis.__captionCalls.push({ id: w.id, ...options })
        set(options)
      }
    }
  })
  for (const theme of ['warm-paper', 'midnight-blue', 'light-modern', 'dark-modern']) {
    await settings.locator(`input[type=radio][value="${theme}"]`).check({ force: true })
    await expect(settings.locator('html')).toHaveAttribute('data-workbench-theme', theme)
    await expect(page.locator('html')).toHaveAttribute('data-workbench-theme', theme)
    const colors = await settings.evaluate(() => ({
      toolbar: getComputedStyle(document.documentElement).getPropertyValue('--workbench-toolbar').trim(),
      ink: getComputedStyle(document.documentElement).getPropertyValue('--workbench-text').trim(),
    }))
    await expect
      .poll(async () =>
        app.evaluate(
          ({ BrowserWindow }, { toolbar, ink }) =>
            BrowserWindow.getAllWindows().every((w) =>
              globalThis.__captionCalls.some(
                (call) => call.id === w.id && call.color === toolbar && call.symbolColor === ink
              )
            ),
          colors
        )
      )
      .toBe(true)
    for (const current of [page, settings]) {
      assert.equal(
        await current
          .locator('.workbench-native-caption')
          .evaluate((el) => getComputedStyle(el).userSelect),
        'none'
      )
      assert.equal(
        await current.locator('.workbench-native-caption').evaluate((el) => {
          const expected = document.createElement('div')
          expected.style.color = 'var(--workbench-toolbar)'
          el.append(expected)
          const matches = getComputedStyle(el).backgroundColor === getComputedStyle(expected).color
          expected.remove()
          return matches
        }),
        true
      )
      assert.equal(
        await current.evaluate(() => innerHeight >= document.documentElement.scrollHeight),
        true
      )
      assert.equal(
        await current.locator('.workbench-native-caption').evaluate((el) => {
          const box = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(box.x + 80, box.y + 16))
        }),
        true,
        'Window content must not cover the title region'
      )
    }
    results.push({ theme, ...colors })
  }
  await settings.getByRole('button', { name: '系统', exact: true }).click()
  await expect(settings.locator('summary').filter({ hasText: '管理更新' })).toContainText(version)
  await expect(settings.getByText('当前版本', { exact: true })).toHaveCount(0)
  await expect(settings.getByText('更新偏好', { exact: true })).toHaveCount(0)
  await expect(settings.getByRole('combobox', { name: '更新通道' })).toBeVisible()
  await expect(settings.getByRole('switch', { name: '自动下载更新' })).toBeVisible()
  await expect(settings.getByRole('button', { name: '检查更新', exact: true })).toHaveCount(1)
  for (const [name, p] of [
    ['settings', settings],
    ['workbench', page],
  ]) {
    const data = await app.evaluate(
      async ({ BrowserWindow }, id) =>
        (
          await BrowserWindow.getAllWindows()
            .find((w) => w.webContents.id === id)
            .webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
        ).toDataURL(),
      await app.browserWindow(p).then((w) => w.evaluate((w) => w.webContents.id))
    )
    await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'))
  }
  console.info(
    'PASS packaged settings: dark first paint, no desktop minimization, synchronized caption colors, version badge, and no viewport overflow'
  )
  console.info(JSON.stringify(results))
} finally {
  await app.close()
}
