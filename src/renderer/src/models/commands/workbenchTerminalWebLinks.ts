import type { Terminal } from '@xterm/xterm'

export interface WorkbenchTerminalWebLink {
  url: string
  row: number
  column: number
}

/** 只读取视口内的网址；按终端格子定位，兼容中文前缀与折行，不在输出文字上盖按钮。 */
export function findWorkbenchTerminalWebLinks(
  terminal: Pick<Terminal, 'buffer' | 'cols' | 'rows'>
): WorkbenchTerminalWebLink[] {
  const buffer = terminal.buffer.active
  if (buffer.type !== 'normal') return []
  const links: WorkbenchTerminalWebLink[] = []
  const cell = buffer.getNullCell()
  const viewportEnd = Math.min(buffer.length, buffer.viewportY + terminal.rows)
  for (let row = buffer.viewportY; row < viewportEnd; row += 1) {
    let first = row
    while (first > 0 && row - first < 16 && buffer.getLine(first)?.isWrapped) first -= 1
    let last = row
    while (last - first < 16 && buffer.getLine(last + 1)?.isWrapped) last += 1
    let text = ''
    const cells: Array<{ x: number; y: number; width: number }> = []
    for (let y = first; y <= last; y += 1) {
      const line = buffer.getLine(y)
      if (!line) break
      const lineText = line.translateToString(true, 0, terminal.cols)
      let length = 0
      for (
        let x = 0;
        x < Math.min(line.length, terminal.cols) && length < lineText.length;
        x += 1
      ) {
        line.getCell(x, cell)
        const width = cell.getWidth()
        if (!width) continue
        const chars = cell.getChars() || ' '
        for (let index = 0; index < chars.length; index += 1) cells.push({ x, y, width })
        text += chars
        length += chars.length
      }
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
      const url = match[0].replace(/[.,;:!?)\]}]+$/u, '')
      try {
        const parsed = new URL(url)
        if (!parsed.hostname || parsed.username || parsed.password) continue
      } catch {
        continue
      }
      const end = cells[match.index + url.length - 1]
      if (!end || end.y < buffer.viewportY || end.y >= viewportEnd) continue
      const column = end.x + end.width
      if (column + 2 > terminal.cols) continue
      const line = buffer.getLine(end.y)
      if (line?.translateToString(true, column, column + 2).trim()) continue
      links.push({ url, row: end.y - buffer.viewportY, column })
    }
    row = last
  }
  return links
}
