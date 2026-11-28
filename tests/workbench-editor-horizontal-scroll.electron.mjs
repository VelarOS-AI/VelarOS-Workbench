// Native regression: node tests/workbench-editor-horizontal-scroll.electron.mjs --show-window <application.exe>
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron, expect } from '@playwright/test'

import { manualElectronTestArgs } from './helpers/manualElectronTest.mjs'

const [packagedApplication] = manualElectronTestArgs()
assert.ok(packagedApplication, 'Pass the native packaged application executable')
const temporary = await mkdtemp(path.join(tmpdir(), 'wb-horizontal-scroll-'))
const project = path.join(temporary, 'project')
await mkdir(project)
const longLine = `const array = [${'0, '.repeat(420)}765432101];`
await writeFile(
  path.join(project, 'longline.ts'),
  [longLine, ...Array.from({ length: 100 }, (_, index) => `// line ${index + 2}`)].join('\n')
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
  await page.getByText('longline.ts', { exact: true }).first().dblclick({ timeout: 30_000 })
  const content = page.locator('.cm-content')
  await expect(content).toContainText('765432101')
  const typeHint = content.locator('.cm-workbenchInlayTypeHint')
  await expect(typeHint).toContainText('number[]')

  const readSelection = () =>
    content.evaluate((element) => {
      const view = element.cmTile.root.view
      const { anchor, head } = view.state.selection.main
      return {
        anchor,
        head,
        scrollLeft: view.scrollDOM.scrollLeft,
        contentLeft: element.scrollLeft,
      }
    })
  const coordinates = await content.evaluate((element) => {
    const view = element.cmTile.root.view
    const scroller = view.scrollDOM
    const pane = scroller.getBoundingClientRect()
    const start = view.coordsAtPos(view.state.doc.line(1).from + 2)
    return {
      startX: start.left,
      textY: (start.top + start.bottom) / 2,
      rightEdge: pane.left + scroller.clientWidth - 3,
      leftEdge: element.getBoundingClientRect().left + 3,
      scrollbarHeight: scroller.offsetHeight - scroller.clientHeight,
      scrollbarY: pane.bottom - (scroller.offsetHeight - scroller.clientHeight) / 2,
      thumbX: pane.left + scroller.clientWidth ** 2 / scroller.scrollWidth / 2,
      scrollerOverflow: scroller.scrollWidth - scroller.clientWidth,
      contentOverflow: element.scrollWidth - element.clientWidth,
    }
  })
  console.info('Horizontal viewport geometry', coordinates)
  assert.ok(coordinates.scrollerOverflow > 100, JSON.stringify(coordinates))
  assert.ok(coordinates.scrollbarHeight > 0, JSON.stringify(coordinates))

  await page.mouse.move(coordinates.thumbX, coordinates.scrollbarY)
  await page.mouse.down()
  await page.mouse.move(coordinates.thumbX + 80, coordinates.scrollbarY, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await readSelection()).scrollLeft).toBeGreaterThan(100)
  await content.evaluate((element) => {
    element.cmTile.root.view.scrollDOM.scrollLeft = 0
  })

  await page.mouse.move(coordinates.startX, coordinates.textY)
  await page.mouse.down()
  const selectionStart = await readSelection()
  await page.mouse.move(coordinates.rightEdge, coordinates.textY, { steps: 16 })
  const rightEdge = await readSelection()
  assert.ok(rightEdge.head > selectionStart.anchor, JSON.stringify({ selectionStart, rightEdge }))
  await expect
    .poll(async () => (await readSelection()).scrollLeft, { timeout: 2000 })
    .toBeGreaterThan(rightEdge.scrollLeft + 30)
  const afterRight = await readSelection()
  assert.equal(afterRight.anchor, selectionStart.anchor)
  assert.ok(afterRight.head > rightEdge.head, JSON.stringify({ rightEdge, afterRight }))
  assert.equal(afterRight.contentLeft, 0)

  // Reversing without releasing should scroll back while retaining the original anchor.
  await page.mouse.move(coordinates.leftEdge, coordinates.textY, { steps: 16 })
  await expect.poll(async () => (await readSelection()).scrollLeft, { timeout: 3000 }).toBe(0)
  await page.mouse.up()
  const released = await readSelection()
  assert.equal(released.anchor, selectionStart.anchor)
  assert.ok(released.head < afterRight.head)
  assert.equal(released.contentLeft, 0)
  await page.waitForTimeout(120)
  assert.deepEqual(await readSelection(), released)

  await page.keyboard.press('End')
  const endToken = content.locator('span').filter({ hasText: /^765432101$/u })
  await expect(endToken).toHaveCSS('color', 'rgb(23, 80, 235)')
  assert.ok((await readSelection()).scrollLeft > 100)
  console.info('PASS native scrollbar drag and selection scrolling in both directions')

  await page.keyboard.press('Home')
  await content.evaluate((element) => {
    const view = element.cmTile.root.view
    const line = view.state.doc.line(1)
    view.dispatch({
      changes: {
        from: line.from,
        to: line.to,
        insert: line.text.replace(/\d+/gu, (number) => JSON.stringify(number)),
      },
      userEvent: 'input.type',
    })
    view.scrollDOM.scrollLeft = 0
  })
  await page.mouse.move(coordinates.startX, coordinates.textY)
  await page.mouse.down()
  await page.mouse.move(coordinates.startX + 80, coordinates.textY, { steps: 8 })
  await page.waitForTimeout(1200)
  await expect(typeHint).toHaveCount(0)
  await page.mouse.up()
  await expect(typeHint).toContainText('string[]')
  console.info('PASS inferred types do not move the text during selection')
} finally {
  await app.close()
}
