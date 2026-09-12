import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'
import type { BrowserWindow } from 'electron'

import {
  installWorkbenchWindowState,
  readWorkbenchWindowState,
} from '../src/main/projects/WorkbenchWindowState'
import { WorkbenchWindowStateChannels } from '../src/shared/workbenchWindowState'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

class FakeWorkbenchWindow extends EventEmitter {
  public fullScreen = false
  public destroyed = false
  public readonly sent: Array<{ channel: string; payload: unknown }> = []
  public readonly webContents = {
    send: (channel: string, payload: unknown): void => {
      this.sent.push({ channel, payload })
    },
  }

  public isFullScreen(): boolean {
    return this.fullScreen
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }
}

void describe('Workbench window and chat chrome details', () => {
  void test('tells each window whether it is full screen so the title row drops the traffic-light inset', () => {
    const window = new FakeWorkbenchWindow()
    installWorkbenchWindowState(window as unknown as BrowserWindow)

    window.fullScreen = true
    window.emit('enter-full-screen')
    window.fullScreen = false
    window.emit('leave-full-screen')
    window.destroyed = true
    window.emit('enter-full-screen')

    assert.deepEqual(window.sent, [
      { channel: WorkbenchWindowStateChannels.changed, payload: { fullScreen: true } },
      { channel: WorkbenchWindowStateChannels.changed, payload: { fullScreen: false } },
    ])
    assert.deepEqual(readWorkbenchWindowState(null), { fullScreen: false })
    assert.deepEqual(
      readWorkbenchWindowState({ isDestroyed: () => false, isFullScreen: () => true }),
      { fullScreen: true }
    )

    const main = readSource('src/main/index.ts')
    const ipc = readSource('src/main/projects/WorkbenchWindowStateIpc.ts')
    const preload = readSource('src/preload/index.ts')
    const hook = readSource('src/renderer/src/hooks/useWorkbenchWindowFullScreen.ts')
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const shellStyles = readSource('src/renderer/src/styles/01-shell.module.css')

    assert.match(main, /installWorkbenchEditorZoom\(window\)\n\s*installWorkbenchWindowState\(window\)/u)
    assert.match(main, /registerWorkbenchWindowStateIpc\(\)/u)
    assert.match(
      ipc,
      /ipcMain\.handle\(WorkbenchWindowStateChannels\.getState[\s\S]*BrowserWindow\.fromWebContents\(event\.sender\)/u
    )
    assert.match(preload, /exposeInMainWorld\('velarosWorkbenchWindowState', windowStateBridge\)/u)
    // 先订阅再补读；收到过推送后，晚回来的初始读取是旧值，不许盖掉推送。
    assert.match(hook, /onChanged\([\s\S]*pushed = true[\s\S]*getState\(\)\.then\(\(state\) => \{\n\s*if \(!pushed\) apply\(state\)/u)
    assert.match(presentation, /const windowFullScreen = useWorkbenchWindowFullScreen\(\)/u)
    assert.match(presentation, /data-mac-title-inset=\{macTitleInset && !windowFullScreen\}/u)
    assert.match(
      shellStyles,
      /\[data-mac-title-inset='true'\] \.ideUnifiedTopBar \{\n\s*padding-left: 76px;/u
    )
  })

  void test('centers the settings gear over the chat button of the right tool rail', () => {
    const topStyles = readSource('src/renderer/src/styles/02-chrome-top.module.css')
    const layoutStyles = readSource('src/renderer/src/styles/03-layout.module.css')
    const topBar = topStyles.match(/\n\.ideUnifiedTopBar \{[^}]*\}/u)?.[0] ?? ''

    // 齿轮中线距右缘 = 留白 + icon / 2，工具条按钮中线距右缘 = rail / 2 → 留白 = (rail − icon) / 2。
    assert.match(
      topBar,
      /padding-inline: 2px calc\(\(var\(--workbench-right-rail-width\) - var\(--ui-icon-button-sm\)\) \/ 2\);/u
    )
    // 按钮边长只由 icon-sm 预设决定，顶栏自己的类不再写一个与之打架的尺寸。
    for (const rule of ['.topRunButton', '.topToolbarIconButton']) {
      const body = topStyles.match(new RegExp(`\\n\\${rule} \\{[^}]*\\}`, 'u'))?.[0] ?? ''
      assert.ok(body, `${rule} rule exists`)
      assert.doesNotMatch(body, /\bwidth:|\bheight:/u)
    }
    assert.match(layoutStyles, /\.rightToolStrip \{\n\s*@apply [^;]*\bitems-center\b/u)
    assert.match(layoutStyles, /\.rightToolRail \{[^}]*width: var\(--workbench-right-rail-width\);/u)
  })

  void test('keeps only the progress ring on the composer context gauge', () => {
    const indicator = readSource(
      'src/renderer/src/runtime/conversation/WorkbenchContextUsageIndicator.tsx'
    )
    const styles = readSource(
      'src/renderer/src/runtime/conversation/WorkbenchContextUsageIndicator.module.css'
    )
    const sharedGauge = readSource(
      'node_modules/@velaros-ai/ui/dist/conversation/status/ChatContextUsageGauge.module.css'
    )
    const viteConfig = readSource('electron.vite.config.ts')

    assert.match(indicator, /<span className=\{styles\.gauge\}>\s*<ChatContextUsageGauge/u)
    assert.match(styles, /\.gauge \{\n\s*display: contents;/u)
    assert.match(styles, /\.gauge \[class\*='_iconRing'\] \{\n\s*box-shadow: none;/u)
    assert.match(styles, /\.gauge \[class\*='_iconOnly'\] \{\n\s*border-color: transparent;/u)
    // 覆写要命中的那圈描边确实还画在共享包的 `.iconRing` 上，类名按 `velar_<哈希>_<local>` 生成。
    // 规则体里嵌着 @supports 块：只在顶层右花括号（行首的 `}`）之前找。
    assert.match(sharedGauge, /\n\.iconRing \{(?:(?!\n\}).)*?box-shadow: inset 0 0 0 1px/su)
    assert.match(viteConfig, /return `velar_\$\{fileHash\}_\$\{name\}`/u)
  })

  void test('colors the run totals like the file rows and keeps the changed-file rows compact', () => {
    const styles = readSource('src/renderer/src/runtime/conversation/WorkbenchRunChangesCard.module.css')
    const card = readSource('src/renderer/src/runtime/conversation/WorkbenchRunChangesCard.tsx')
    const sharedList = readSource(
      'node_modules/@velaros-ai/ui/dist/conversation/cards/FileChangeSummaryList.module.css'
    )

    // 合计是共享 Text 原语，默认色阶自带正文色；抬高特异性，颜色与文件行统计同一对令牌。
    assert.match(card, /<Text className=\{styles\.added\}>/u)
    assert.match(styles, /\.added\.added \{\n\s*color: var\(--status-green\);/u)
    assert.match(styles, /\.removed\.removed \{\n\s*color: var\(--status-red\);/u)
    assert.match(sharedList, /\n\.added \{\n\s*color: var\(--status-green\);/u)
    assert.match(sharedList, /\n\.removed \{\n\s*color: var\(--status-red\);/u)
    // 行收到 30px：上下 4px + 22px 的箭头按钮；箭头按钮钉回它那条 22px 网格列。
    assert.match(styles, /\.root \[class\*='_fileButton'\] \{\n\s*min-height: 30px;\n\s*padding-block: 4px;/u)
    assert.match(styles, /\.root \[class\*='_fileExpandButton'\] \{\n\s*width: 22px;\n\s*height: 22px;/u)
    assert.match(sharedList, /\.fileButton \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto 22px;/u)
    assert.match(sharedList, /\.fileExpandButton \{/u)
  })
})
