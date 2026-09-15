/**
 * 每个会话一个 xterm 实例，活到会话被关掉为止：切标签、折叠面板只是把它的 DOM 摘下来再挂回去，
 * 滚回历史与光标状态都还在。输出经 {@link attachWorkbenchTerminalOutput} 直送 `terminal.write`。
 */
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'

import {
  attachWorkbenchTerminalOutput,
  onWorkbenchTerminalOutputDiscarded,
} from '../../models/commands/workbenchTerminalOutputBus'

import '@xterm/xterm/css/xterm.css'

export interface WorkbenchTerminalInstanceHandlers {
  onData: (data: string) => void
  onOpenLink: (url: string) => void
}

export interface WorkbenchTerminalInstance {
  terminal: Terminal
  fit: FitAddon
  handlers: WorkbenchTerminalInstanceHandlers
  opened: boolean
}

interface WorkbenchTerminalEntry extends WorkbenchTerminalInstance {
  detachOutput: () => void
  webgl: Nullable<WebglAddon>
}

const entries = new Map<string, WorkbenchTerminalEntry>()
let discardHookInstalled = false

function installDiscardHook(): void {
  if (discardHookInstalled) return
  discardHookInstalled = true
  onWorkbenchTerminalOutputDiscarded(releaseWorkbenchTerminal)
}

export function findWorkbenchTerminal(sessionId: string): Nullable<WorkbenchTerminalInstance> {
  return entries.get(sessionId) ?? null
}

export function acquireWorkbenchTerminal(
  sessionId: string,
  handlers: WorkbenchTerminalInstanceHandlers,
  options: { fontFamily: string }
): WorkbenchTerminalInstance {
  installDiscardHook()
  const existing = entries.get(sessionId)
  if (existing) {
    existing.handlers = handlers
    return existing
  }

  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: options.fontFamily,
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 5_000,
    // PTY 输出自带 CR LF；宿主的提示也按 CR LF 发。
    convertEol: false,
    macOptionIsMeta: false,
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  // 中日韩与 emoji 按 Unicode 11 算宽度，否则中文会挤成半格、光标错位。
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  const entry: WorkbenchTerminalEntry = {
    terminal,
    fit,
    handlers,
    opened: false,
    detachOutput: () => undefined,
    webgl: null,
  }
  terminal.loadAddon(new WebLinksAddon((_event, uri) => entry.handlers.onOpenLink(uri)))
  terminal.onData((data) => entry.handlers.onData(data))
  terminal.onBinary((data) => entry.handlers.onData(data))
  entry.detachOutput = attachWorkbenchTerminalOutput(sessionId, (chunk) => terminal.write(chunk))
  entries.set(sessionId, entry)
  return entry
}

/** 第一次挂进容器时打开 xterm；之后只是把已有 DOM 挂回去。 */
export function mountWorkbenchTerminal(sessionId: string, container: HTMLElement): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  if (!entry.opened) {
    entry.opened = true
    entry.terminal.open(container)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        entry.webgl = null
      })
      entry.terminal.loadAddon(webgl)
      entry.webgl = webgl
    } catch {
      // arch-guard:silent-catch-ok WebGL 拿不到上下文（显卡、上下文数上限）就用 DOM 渲染器，功能一样。
    }
    return
  }
  const element = entry.terminal.element
  if (element && element.parentElement !== container) container.append(element)
}

export function unmountWorkbenchTerminal(sessionId: string): void {
  entries.get(sessionId)?.terminal.element?.remove()
}

export function releaseWorkbenchTerminal(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  entries.delete(sessionId)
  entry.detachOutput()
  entry.webgl?.dispose()
  entry.terminal.dispose()
}
