// Native package smoke test: node tests/workbench-editor-behavior.electron.mjs <application.exe>
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'

const executablePath = process.argv[2]
assert.ok(executablePath, 'Pass the native packaged application executable')
const temporary = await mkdtemp(path.join(tmpdir(), 'wb-editor-package-'))
const profile = path.join(temporary, 'profile')
const projectRoot = path.join(temporary, 'project')
await mkdir(projectRoot)
const content =
  'import { greet } from "./helper"\nconst message = greet("World")\nconsole.log(message)\n'
const vueContent =
  '<script setup lang="ts">\nfunction formatDate(value: Date): string { return value.toISOString() }\nconst values = Array.from(new Map([["a", new Date()]]).values()).map(formatDate)\nconst count: number = "wrong"\n</script>\n<template><div>{{ values }} {{ count }}</div></template>\n'
await Promise.all([
  writeFile(path.join(projectRoot, 'main.ts'), content),
  writeFile(
    path.join(projectRoot, 'helper.ts'),
    '/** Build a greeting. */\nexport function greet(name: string): string { return `Hello ${name}` }\n'
  ),
  writeFile(path.join(projectRoot, 'Main.java'), 'public class Main {}\n'),
  writeFile(path.join(projectRoot, 'main.py'), 'print("Hello")\n'),
  writeFile(path.join(projectRoot, 'App.vue'), vueContent),
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
  await identifier.click({ modifiers: ['Control'] })
  await expect(page.locator('.cm-content')).toContainText('export function greet', {
    timeout: 15_000,
  })
  console.info('PASS Ctrl+click definition navigation')

  await page.locator('.wb_editorTab').filter({ hasText: 'main.ts' }).first().click()
  if ((await page.locator('.cm-content[contenteditable="true"]').count()) === 0)
    await page.getByRole('button', { name: /^只读模式|^Read.only mode/ }).click()
  await page.locator('.cm-content[contenteditable="true"]').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nconsole.', { delay: 60 })
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('log', { timeout: 15_000 })
  console.info('PASS completion popup while typing')
  const settings = page
    .getByRole('complementary', { name: '右侧工具窗口' })
    .getByRole('button')
    .first()
  await expect(settings).toHaveAccessibleName('设置')
  await page.keyboard.press('Escape')
  await settings.hover()
  await expect(
    page.locator('[data-slot="tooltip-content"]').filter({ hasText: '设置' })
  ).toBeVisible()
  for (const [kind, token] of [
    ['java', '--workbench-file-java'],
    ['python', '--workbench-file-python'],
    ['vue', '--workbench-file-vue'],
  ]) {
    const icon = page.locator(`[data-file-icon-kind="${kind}"]`).first()
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute('data-language-logo', 'devicon')
    const hex = await page
      .locator('html')
      .evaluate((element, token) => getComputedStyle(element).getPropertyValue(token).trim(), token)
    const color = `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`
    await expect(icon).toHaveCSS('fill', color)
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
  assert.deepEqual(errors, [])
  const output = path.resolve('artifacts/editor-regression')
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'verified-package.png') })
  console.info('PASS settings position, language icons, and renderer error check')
} finally {
  await app.close()
}
