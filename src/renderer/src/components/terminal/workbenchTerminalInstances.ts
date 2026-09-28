/**
 * 每个会话一个 xterm 实例，活到会话被关掉为止：切标签、折叠面板只是把它的 DOM 摘下来再挂回去，
 * 滚回历史与光标状态都还在。输出经 {@link attachWorkbenchTerminalOutput} 直送 `terminal.write`。
 */
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { type IBufferRange, type ILink, Terminal } from '@xterm/xterm'

import {
  findWorkbenchTerminalFileLinks,
  parseWorkbenchTerminalCwdReport,
  type WorkbenchTerminalFileLink,
} from '../../models/commands/workbenchTerminalFileLinks'
import {
  attachWorkbenchTerminalOutput,
  onWorkbenchTerminalOutputDiscarded,
} from '../../models/commands/workbenchTerminalOutputBus'

import '@xterm/xterm/css/xterm.css'

export interface WorkbenchTerminalInstanceHandlers {
  onData: (data: string) => void
  onOpenLink: (url: string) => void
  /**
   * 一行输出里的这些路径各是项目里的哪个文件（`cwd` 是 shell 当前所在的目录），不是项目里的文件给 null。
   * 没给就不认文件路径。
   */
  resolveFileLinks?: (paths: readonly string[], cwd: string) => Promise<Array<Nullable<string>>>
  onOpenFileLink?: (path: string, line?: number, column?: number) => void
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
  /** shell 当前所在的目录：起始目录，之后跟着 shell 用 OSC 7 报的走（不报的 shell 就一直是起始目录）。 */
  cwd: string
}

/** 一段折行的输出最多往上、往下各拼这么多行来找路径。 */
const MaxWrappedRows = 16

/** 拼起来的一行文字里，每个 UTF-16 码元落在哪个格子（0 起），宽字符占几格。 */
interface TerminalTextCell {
  x: number
  y: number
  width: number
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
  options: { fontFamily: string; cwd: string }
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
    cwd: options.cwd,
  }
  terminal.loadAddon(new WebLinksAddon((_event, uri) => entry.handlers.onOpenLink(uri)))
  terminal.registerLinkProvider({
    provideLinks: (lineNumber, callback) => provideFileLinks(entry, lineNumber, callback),
  })
  terminal.parser.registerOscHandler(7, (data) => {
    entry.cwd = parseWorkbenchTerminalCwdReport(data) ?? entry.cwd
    return true
  })
  terminal.onData((data) => entry.handlers.onData(data))
  terminal.onBinary((data) => entry.handlers.onData(data))
  // 写完再确认（xterm 解析完这段才回调），主进程据此决定暂停还是继续读伪终端。
  entry.detachOutput = attachWorkbenchTerminalOutput(sessionId, (chunk, done) =>
    terminal.write(chunk, done)
  )
  entries.set(sessionId, entry)
  return entry
}

/**
 * 鼠标所在那一行里的文件路径：连同折行拼成整行来找，问过确实是项目里的文件才给链接。点一下（没在选文字时）
 * 在编辑器里打开，带行列的跳到那里。
 */
function provideFileLinks(
  entry: WorkbenchTerminalEntry,
  lineNumber: number,
  callback: (links: ILink[] | undefined) => void
): void {
  const resolveFileLinks = entry.handlers.resolveFileLinks
  if (!resolveFileLinks) return callback(undefined)

  const { text, cells } = readWrappedLine(entry.terminal, lineNumber - 1)
  const found = findWorkbenchTerminalFileLinks(text)
    .map((link) => ({ link, range: toBufferRange(cells, link) }))
    .filter(({ range }) => range.start.y <= lineNumber && range.end.y >= lineNumber)
  if (found.length === 0) return callback(undefined)

  resolveFileLinks(
    found.map(({ link }) => link.path),
    entry.cwd
  ).then(
    (paths) => {
      const links = found.flatMap(({ link, range }, index): ILink[] => {
        const path = paths[index]
        if (!path) return []
        return [
          {
            range,
            text: text.slice(link.start, link.end),
            activate: (event) => {
              if (event.button !== 0 || entry.terminal.hasSelection()) return
              entry.handlers.onOpenFileLink?.(path, link.line, link.column)
            },
          },
        ]
      })
      callback(links.length > 0 ? links : undefined)
    },
    () => callback(undefined)
  )
}

/** 从 `row`（0 起）所在的那段折行里读出整行文字，并记下每个字符的格子。宽字符只记一次，占的格数记在 width 上。 */
function readWrappedLine(
  terminal: Terminal,
  row: number
): { text: string; cells: TerminalTextCell[] } {
  const buffer = terminal.buffer.active
  let first = row
  while (first > 0 && row - first < MaxWrappedRows && buffer.getLine(first)?.isWrapped) first -= 1
  let last = row
  while (last - row < MaxWrappedRows && buffer.getLine(last + 1)?.isWrapped) last += 1

  const cell = buffer.getNullCell()
  let text = ''
  const cells: TerminalTextCell[] = []
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y)
    if (!line) break
    // 行尾从没写过的格子不算文字（宽字符在行尾放不下、挪到下一行时留下的空位也是这样）。
    let end = line.length
    while (end > 0 && line.getCell(end - 1, cell) && !cell.getChars() && cell.getWidth() === 1)
      end -= 1
    for (let x = 0; x < end; x += 1) {
      line.getCell(x, cell)
      const width = cell.getWidth()
      // 宽字符的后半格。
      if (width === 0) continue
      const chars = cell.getChars() || ' '
      for (let index = 0; index < chars.length; index += 1) cells.push({ x, y, width })
      text += chars
    }
  }
  return { text, cells }
}

/** 文字位置换成 xterm 的格子范围（1 起，末尾含在内）。 */
function toBufferRange(cells: readonly TerminalTextCell[], link: WorkbenchTerminalFileLink): IBufferRange {
  const first = cells[link.start]!
  const last = cells[link.end - 1]!
  return {
    start: { x: first.x + 1, y: first.y + 1 },
    end: { x: last.x + last.width, y: last.y + 1 },
  }
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
