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
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__captionCalls = []
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
  for (const theme of ['dark-modern', 'warm-paper', 'midnight-blue', 'light-modern']) {
    await settings.locator(`input[type=radio][value="${theme}"]`).check({ force: true })
    await expect(settings.locator('html')).toHaveAttribute('data-workbench-theme', theme)
    await expect(page.locator('html')).toHaveAttribute('data-workbench-theme', theme)
    const colors = await settings.evaluate(() => ({
      bg: getComputedStyle(document.documentElement).getPropertyValue('--workbench-bg').trim(),
      ink: getComputedStyle(document.documentElement).getPropertyValue('--workbench-text').trim(),
    }))
    await expect
      .poll(async () =>
        app.evaluate(
          ({ BrowserWindow }, { bg, ink }) =>
            BrowserWindow.getAllWindows().every((w) =>
              globalThis.__captionCalls.some(
                (call) => call.id === w.id && call.color === bg && call.symbolColor === ink
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
    'PASS packaged settings: native caption colors synchronize across main/settings for all four themes; title is not selectable; one update action and version badge; no viewport overflow'
  )
  console.info(JSON.stringify(results))
} finally {
  await app.close()
}
