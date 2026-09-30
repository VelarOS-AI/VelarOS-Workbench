import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
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

function listSourceFiles(relativeDirectory: string): string[] {
  const root = path.resolve(process.cwd(), relativeDirectory)
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.(?:ts|tsx)$/u.test(entry))
    .map((entry) => path.join(relativeDirectory, entry))
}

/** 选择器恰好以 `selector {` 开头的那条顶层规则（含规则体）；找不到时为空串。 */
function ruleBody(styles: string, selector: string): string {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return styles.match(new RegExp(`\\n${escaped} \\{[^}]*\\}`, 'u'))?.[0] ?? ''
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
      /\[data-mac-title-inset='true'\] \.ideUnifiedTopBar,\n[^{]*\[data-mac-title-inset='true'\] \.workbenchSettingsHeader \{\n\s*padding-left: 76px;/u
    )
  })

  void test('pushes full-screen changes to the window that changed, one window at a time', () => {
    const first = new FakeWorkbenchWindow()
    const second = new FakeWorkbenchWindow()
    installWorkbenchWindowState(first as unknown as BrowserWindow)
    installWorkbenchWindowState(second as unknown as BrowserWindow)

    second.fullScreen = true
    second.emit('enter-full-screen')

    assert.deepEqual(first.sent, [])
    assert.deepEqual(second.sent, [
      { channel: WorkbenchWindowStateChannels.changed, payload: { fullScreen: true } },
    ])

    // 设置页与文件历史不是独立窗口：主进程只有一种界面 BrowserWindow，由创建项目窗口的工厂装上推送，
    // 所以它们跟着所在的项目窗口一起拿到全屏状态。以后若另开界面窗口，这里会先失败。网上查资料的无头页面与
    // Agent 浏览器的后台页面也是 BrowserWindow，但从不显示、没有界面，不需要全屏状态。
    const windowFactories = listSourceFiles('src/main').filter((file) =>
      /new BrowserWindow\(/u.test(readSource(file))
    )
    const hiddenPages = [
      path.join('src/main', 'browser', 'WorkbenchBrowserBackgroundPages.ts'),
      path.join('src/main', 'conversation', 'WorkbenchWebSearchPages.ts'),
    ]
    assert.deepEqual(windowFactories.sort(), [...hiddenPages, path.join('src/main', 'index.ts')].sort())
    for (const file of hiddenPages) assert.match(readSource(file), /show: false,/u, file)
    assert.equal(readSource('src/main/index.ts').match(/new BrowserWindow\(/gu)?.length, 1)
  })

  void test('drops the traffic-light inset on the settings page and never reserves it in file history', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const settingsDialog = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const settingsStyles = readSource('src/renderer/src/styles/14-settings.module.css')
    const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')
    const historyView = readSource('src/renderer/src/components/editor/FileHistoryView.tsx')
    const historyStyles = readSource('src/renderer/src/styles/10-history.module.css')

    // 设置页是外壳里的同窗浮层（不走 portal），外壳上的 data-mac-title-inset 管得到它的标题行。
    const shellStart = presentation.indexOf('data-mac-title-inset=')
    const settingsAt = presentation.indexOf('<WorkbenchSettingsDialog')
    const quickOpenAt = presentation.indexOf('<LazyQuickOpen')
    assert.ok(shellStart > 0 && shellStart < settingsAt && settingsAt < quickOpenAt)
    assert.doesNotMatch(settingsDialog, /createPortal/u)
    // 左侧常规留白与侧栏导航文字对齐；76px 只在外壳标记了红绿灯空位时才撑出来。
    const header = ruleBody(settingsStyles, '.workbenchSettingsHeader')
    assert.match(header, /padding-inline: 18px 10px;/u)
    assert.doesNotMatch(header, /76px/u)

    // 文件历史在编辑区里就地展开，头部压不到红绿灯，也不是窗口拖拽区。
    assert.match(editorPanel, /<FileHistoryView/u)
    assert.match(historyView, /<header className=\{styles\.editorGitHistoryHeader\}>/u)
    assert.doesNotMatch(historyStyles, /78px|-webkit-app-region|fileHistoryWindow/u)
  })

  void test('loads the shared UI stylesheets before every app module', () => {
    const entry = readSource('src/renderer/src/main.tsx')
    const globalStyles = readSource('src/renderer/src/globalStyles.ts')

    // 产物里样式按模块求值顺序拼接：全局样式表必须是入口的第一个导入，产品样式才排在共享原语之后。
    const firstImport = entry.split('\n').find((line) => line.startsWith('import '))
    assert.equal(firstImport, "import './globalStyles'")
    assert.deepEqual(
      [...globalStyles.matchAll(/^import '([^']+)'$/gmu)].map((match) => match[1]),
      [
        '@velaros-ai/ui/styles/tokens/design-tokens.css',
        '@velaros-ai/ui/styles/components/index.css',
        '@velaros-ai/ui/styles/components/product.css',
        './index.css',
      ]
    )
    // 顺序只有一个主人：别处再引一次共享全局样式，就可能把它们重新排到应用模块后面。
    const otherOwners = listSourceFiles('src/renderer').filter(
      (file) =>
        !file.endsWith('globalStyles.ts')
        && /['"]@velaros-ai\/ui\/styles\//u.test(readSource(file))
    )
    assert.deepEqual(otherOwners, [])
  })

  void test('keeps the shared focus ring and the conversation rhythm the Workbench has always shown', () => {
    const settingsStyles = readSource('src/renderer/src/styles/14-settings.module.css')
    const overrides = readSource('src/renderer/src/styles/15-overrides.module.css')
    const chatStyles = readSource('src/renderer/src/styles/04-insight-chat.module.css')
    const bubble = readSource('node_modules/@velaros-ai/ui/dist/conversation/blocks/MessageBubble.module.css')
    const pane = readSource('node_modules/@velaros-ai/ui/dist/conversation/shell/ChatConversationPane.module.css')

    // 按钮去阴影仍是两个类的分量（发送按钮有内容时的投影照旧压住），只给原语同分量的聚焦环与分段控件选中项的
    // 悬停投影让路；标签 / 面板里两个类的那组也不压阴影，带子选择器或元素名、特异性更高的那组一直连聚焦环一起
    // 压掉，保持原样。
    assert.match(settingsStyles, /\n\.root \[data-slot='button'\] \{\n\s*transform: none;\n\}/u)
    assert.match(
      settingsStyles,
      /\n\.root :global\(\[data-slot='button'\]:where\(:not\(:focus-visible, \.velar-segmented-control-active:hover\)\)\) \{\n\s*box-shadow: none;\n\}/u
    )
    const primitives = 'node_modules/@velaros-ai/ui/dist/styles/components/primitives'
    assert.match(readSource(`${primitives}/button.css`), /\n\.velar-button:focus-visible \{\n\s*box-shadow:/u)
    assert.match(
      readSource(`${primitives}/segmented-control.css`),
      /\.velar-segmented-control-active:hover \{[^}]*box-shadow:/u
    )
    assert.doesNotMatch(ruleBody(overrides, '.workbenchShell .workbenchContextMenuItem'), /box-shadow/u)
    assert.match(ruleBody(overrides, '.workbenchShell .editorTabContextMenu button'), /box-shadow: none;/u)
    // 共享包这两条规则还在，Workbench 的钉住才有意义；共享包改了取值就该回来重新定夺。
    assert.match(bubble, /\n\.textContent \{[^}]*line-height: calc\(var\(--spacing, 0\.25rem\) \* 6\);/u)
    assert.match(pane, /\n\.messageListInnerSide \{[^}]*gap: calc\(var\(--spacing, 0\.25rem\) \* 3\);/u)
    assert.match(
      chatStyles,
      /\.workbenchChatBody :global\(\.velar-paragraph\)\[class\*='_textContent'\] \{\n\s*line-height: var\(--ui-line-default\);/u
    )
    assert.match(
      chatStyles,
      /\.workbenchChatBody :global\(\.velar-stack-gap-lg\)\[class\*='_messageListInnerSide'\] \{\n\s*gap: var\(--ui-space-4\);/u
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
    // 按钮边长只由 icon-sm 预设决定：顶栏图标按钮的类不再写尺寸、圆角或配色，运行按钮只在禁用时转灰。
    const toolbar = readSource('src/renderer/src/components/chrome/TopToolbar.tsx')
    assert.match(toolbar, /function WorkbenchTopIconAction[\s\S]*<IconButton\n\s*variant="ghost"\n\s*size="icon-sm"/u)
    assert.doesNotMatch(topStyles, /\.topToolbarIconButton/u)
    // 运行按钮只染色（绿、悬停淡绿底、禁用灰），边长与圆角照旧归 icon-sm。
    assert.deepEqual(
      [...topStyles.matchAll(/\n(\.topRunButton[^{]*) \{/gu)].map((match) => match[1]),
      ['.topRunButton', '.topRunButton:hover:not(:disabled)', '.topRunButton:disabled']
    )
    assert.match(topStyles, /\n\.topRunButton \{\n\s*color: var\(--status-green\);\n\}/u)
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

    // 合计是共享 Text 原语，默认色阶自带正文色；全局样式表先加载，单类就压得住，颜色与文件行统计同一对令牌。
    assert.match(card, /<Text className=\{styles\.added\}>/u)
    assert.match(styles, /\n\.added \{\n\s*color: var\(--status-green\);/u)
    assert.match(styles, /\n\.removed \{\n\s*color: var\(--status-red\);/u)
    assert.doesNotMatch(styles, /\.(added|removed|reviewButton)\.\1/u)
    assert.match(sharedList, /\n\.added \{\n\s*color: var\(--status-green\);/u)
    assert.match(sharedList, /\n\.removed \{\n\s*color: var\(--status-red\);/u)
    // 行收到 30px：上下 4px + 22px 的箭头按钮；箭头按钮的 22px 由共享列表自己的 `.fileExpandButton` 给出，
    // 与它那条 22px 网格列同宽，卡片不再另外钉尺寸。
    assert.match(styles, /\.root \[class\*='_fileButton'\] \{\n\s*min-height: 30px;\n\s*padding-block: 4px;/u)
    assert.doesNotMatch(styles, /_fileExpandButton/u)
    assert.match(sharedList, /\.fileButton \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto 22px;/u)
    assert.match(sharedList, /\n\.fileExpandButton \{[^}]*width: 22px;\n\s*height: 22px;/u)
  })
})
