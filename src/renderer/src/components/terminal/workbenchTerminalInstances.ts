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
import {
  matchWorkbenchTerminalPaneKey,
  type WorkbenchTerminalPaneAction,
} from '../../models/commands/workbenchTerminalSplits'
import type { WorkbenchEditorFindStatus } from '../../models/editor/workbenchEditorFindState'

import {
  decorateWorkbenchTerminalSearch,
  describeWorkbenchTerminalSearch,
  disposeWorkbenchTerminalSearch,
  refreshWorkbenchTerminalSearch,
  startWorkbenchTerminalSearch,
  stepWorkbenchTerminalSearch,
  type WorkbenchTerminalFindColors,
  type WorkbenchTerminalSearch,
} from './workbenchTerminalSearch'

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
  /** 在终端里按了 ⌘F（其它平台 Ctrl+F）；`selection` 是此刻选中的文字。 */
  onFind?: (selection: string) => void
  /** 查找栏开着时输出变了，匹配数跟着变。 */
  onFindStatusChange?: (status: WorkbenchEditorFindStatus) => void
  /**
   * 在终端里按了拆分、换到旁边那个终端的键。返回 true 是接下了（这个键不再交给 shell）；没给、返回 false
   * （没有旁边的终端可换）就照常交给 shell。
   */
  onPaneAction?: (action: WorkbenchTerminalPaneAction) => boolean
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
  /** 查找栏开着时的查找状态。 */
  search: Nullable<WorkbenchTerminalSearch>
  /** 输出变了、视口滚了之后重找、补画的定时器（节流：一段连续输出里至多隔一会儿做一次）。 */
  searchRefreshTimer: Nullable<ReturnType<typeof setTimeout>>
  searchDecorateTimer: Nullable<ReturnType<typeof setTimeout>>
}

/** 查找栏开着时，输出变了之后隔这么久重找一次。 */
const SearchRefreshDelayMs = 200
/** 滚动之后隔这么久补画视口附近的匹配。 */
const SearchDecorateDelayMs = 30
const isApplePlatform = /Mac|iPhone|iPad/u.test(navigator.platform)

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
    search: null,
    searchRefreshTimer: null,
    searchDecorateTimer: null,
  }
  terminal.loadAddon(new WebLinksAddon((_event, uri) => entry.handlers.onOpenLink(uri)))
  terminal.registerLinkProvider({
    provideLinks: (lineNumber, callback) => provideFileLinks(entry, lineNumber, callback),
  })
  terminal.parser.registerOscHandler(7, (data) => {
    entry.cwd = parseWorkbenchTerminalCwdReport(data) ?? entry.cwd
    return true
  })
  // ⌘F（其它平台 Ctrl+F）打开终端的查找栏，拆分、换到旁边的终端也在这里接下，都不再交给 shell。
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (isFindShortcut(event) && entry.handlers.onFind) {
      event.preventDefault()
      entry.handlers.onFind(terminal.getSelection())
      releaseHeldKey(terminal)
      return false
    }
    const paneAction = matchWorkbenchTerminalPaneKey(event, isApplePlatform)
    if (paneAction && entry.handlers.onPaneAction?.(paneAction)) {
      event.preventDefault()
      releaseHeldKey(terminal)
      return false
    }
    return true
  })
  terminal.onWriteParsed(() => scheduleSearchRefresh(entry))
  terminal.onScroll(() => scheduleSearchDecorate(entry))
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

/**
 * 一个键把焦点带走了（查找栏、旁边的终端），xterm 等不到它的 keyup（macOS 上按着 ⌘ 时字母键本来也没有 keyup），
 * 会一直当有键按着，回到这个终端后吞掉 insertText 送来的输入（听写、表情面板）。补一个 Shift 的 keyup 让它
 * 复位；只有修饰键的 keyup 不会让 xterm 把焦点抢回去。
 */
function releaseHeldKey(terminal: Terminal): void {
  queueMicrotask(() =>
    terminal.textarea?.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bubbles: true })
    )
  )
}

function isFindShortcut(event: KeyboardEvent): boolean {
  const primary = isApplePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return primary && !event.altKey && !event.shiftKey && event.code === 'KeyF'
}

/**
 * 按查找词在终端里找，画出匹配并滚到当前那处；`pattern` 为 null（查找词为空、正则写错）时撤掉高亮。
 * 终端不在了给 null。
 */
export function findInWorkbenchTerminal(
  sessionId: string,
  pattern: Nullable<RegExp>,
  colors: WorkbenchTerminalFindColors
): Nullable<WorkbenchEditorFindStatus> {
  const entry = entries.get(sessionId)
  if (!entry) return null
  if (!pattern) {
    closeWorkbenchTerminalFind(sessionId)
    return null
  }
  entry.search = startWorkbenchTerminalSearch(entry.terminal, pattern, colors, entry.search)
  return describeWorkbenchTerminalSearch(entry.search)
}

/** 到下一处（1）或上一处（-1）匹配。 */
export function stepWorkbenchTerminalFind(
  sessionId: string,
  direction: 1 | -1
): Nullable<WorkbenchEditorFindStatus> {
  const entry = entries.get(sessionId)
  if (!entry?.search) return null
  entry.search = stepWorkbenchTerminalSearch(entry.terminal, entry.search, direction)
  return describeWorkbenchTerminalSearch(entry.search)
}

/** 关掉查找：撤掉高亮，不再跟着输出重找。 */
export function closeWorkbenchTerminalFind(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  clearSearchTimers(entry)
  disposeWorkbenchTerminalSearch(entry.search)
  entry.search = null
}

function scheduleSearchRefresh(entry: WorkbenchTerminalEntry): void {
  if (!entry.search || entry.searchRefreshTimer) return
  entry.searchRefreshTimer = setTimeout(() => {
    entry.searchRefreshTimer = null
    if (!entry.search) return
    entry.search = refreshWorkbenchTerminalSearch(entry.terminal, entry.search)
    entry.handlers.onFindStatusChange?.(describeWorkbenchTerminalSearch(entry.search))
  }, SearchRefreshDelayMs)
}

function scheduleSearchDecorate(entry: WorkbenchTerminalEntry): void {
  if (!entry.search || entry.searchDecorateTimer) return
  entry.searchDecorateTimer = setTimeout(() => {
    entry.searchDecorateTimer = null
    if (entry.search) decorateWorkbenchTerminalSearch(entry.terminal, entry.search)
  }, SearchDecorateDelayMs)
}

function clearSearchTimers(entry: WorkbenchTerminalEntry): void {
  if (entry.searchRefreshTimer) clearTimeout(entry.searchRefreshTimer)
  if (entry.searchDecorateTimer) clearTimeout(entry.searchDecorateTimer)
  entry.searchRefreshTimer = null
  entry.searchDecorateTimer = null
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
  clearSearchTimers(entry)
  disposeWorkbenchTerminalSearch(entry.search)
  entry.detachOutput()
  entry.webgl?.dispose()
  entry.terminal.dispose()
}
