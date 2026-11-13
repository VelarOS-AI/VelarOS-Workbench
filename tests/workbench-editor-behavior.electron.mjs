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
const content = 'import { greet } from "./helper"\nconst message = greet("World")\nconsole.log(message)\n'
await Promise.all([
  writeFile(path.join(projectRoot, 'main.ts'), content),
  writeFile(path.join(projectRoot, 'helper.ts'), '/** Build a greeting. */\nexport function greet(name: string): string { return `Hello ${name}` }\n'),
  writeFile(path.join(projectRoot, 'Main.java'), 'public class Main {}\n'),
  writeFile(path.join(projectRoot, 'main.py'), 'print("Hello")\n'),
  writeFile(path.join(projectRoot, 'App.vue'), '<template><div>Hello</div></template>\n'),
  writeFile(path.join(projectRoot, 'package.json'), '{"type":"module"}'),
  writeFile(path.join(projectRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, lib: ['ES2022', 'DOM'] },
    include: ['*.ts'],
  })),
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
  const diagnostics = await page.evaluate((request) => window.velarosWorkbenchLanguage.getDiagnostics(request), {
    projectRoot, path: 'main.ts', language: 'typescript', content,
  })
  assert.ok(diagnostics.ok, JSON.stringify(diagnostics))
  assert.deepEqual(diagnostics.value.diagnostics, [], 'The packaged standard library must resolve console and string')
  console.info('PASS packaged standard library and diagnostics')

  const completions = await page.evaluate((request) => window.velarosWorkbenchLanguage.getCompletions(request), {
    projectRoot, path: 'main.ts', language: 'typescript', content, position: { line: 3, column: 9 },
  })
  assert.ok(completions.ok && completions.value.items.some((item) => item.label === 'log'), JSON.stringify(completions))
  console.info('PASS console member completions')

  const identifier = page.locator('.cm-content').getByText('greet', { exact: true }).last()
  await page.bringToFront()
  await identifier.hover()
  await expect(page.locator('.cm-tooltip-hover')).toContainText('greet', { timeout: 15_000 })
  console.info('PASS symbol hover tooltip')
  await identifier.click({ modifiers: ['Control'] })
  await expect(page.locator('.cm-content')).toContainText('export function greet', { timeout: 15_000 })
  console.info('PASS Ctrl+click definition navigation')

  await page.locator('.wb_editorTab').filter({ hasText: 'main.ts' }).first().click()
  if (await page.locator('.cm-content[contenteditable="true"]').count() === 0)
    await page.getByRole('button', { name: /^只读模式|^Read.only mode/ }).click()
  await page.locator('.cm-content[contenteditable="true"]').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nconsole.', { delay: 60 })
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('log', { timeout: 15_000 })
  console.info('PASS completion popup while typing')
  const settings = page.getByRole('complementary', { name: '右侧工具窗口' }).getByRole('button').first()
  await expect(settings).toHaveAccessibleName('设置')
  await page.keyboard.press('Escape')
  await settings.hover()
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: '设置' })).toBeVisible()
  for (const [kind, color] of [['java', 'rgb(199, 70, 52)'], ['python', 'rgb(56, 118, 171)'], ['vue', 'rgb(35, 150, 107)']]) {
    const icon = page.locator(`[data-file-icon-kind="${kind}"]`).first()
    await expect(icon).toBeVisible()
    await expect(icon).toHaveCSS('fill', color)
  }
  assert.deepEqual(errors, [])
  const output = path.resolve('artifacts/editor-regression')
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, 'verified-package.png') })
  console.info('PASS settings position, language icons, and renderer error check')
} finally {
  await app.close()
}
