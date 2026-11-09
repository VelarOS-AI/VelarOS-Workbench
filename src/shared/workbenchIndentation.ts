/**
 * 按正文识别一个文件的缩进。编辑器用它定状态栏里的缩进（没有 `.editorconfig`、用户也没选时），语言服务的
 * worker 用它看「别的文件」用什么缩进（一次跨文件的修复、重构里，各个文件按各自的缩进写）。
 */

/** 从正文里识别出的缩进（识别不出来就没有）。 */
export interface WorkbenchDetectedIndentation {
  style: 'space' | 'tab'
  /** 空格缩进一级几格；制表符缩进时不看。 */
  size: number
}

/** 识别只看开头这么多行，大文件也不卡。 */
const MaxDetectionLines = 10_000
/** 空格缩进只认这些宽度（1 格多半是对齐，比如 JSDoc 的 ` *`）。 */
const DetectableSpaceSizes = [2, 3, 4, 6, 8]
export const DefaultWorkbenchTabSize = 4

/**
 * 按正文识别缩进：缩进用制表符的行多就是制表符；否则看相邻两行缩进「加深」了几格，出现最多的那个宽度就是一级缩进
 * （退格可能一次退好几级，只看加深）。没有缩进过的行时识别不出来。
 */
export function detectWorkbenchIndentation(content: string): Nullable<WorkbenchDetectedIndentation> {
  let tabLines = 0
  let spaceLines = 0
  let previousSpaces: Nullable<number> = 0
  const increases = new Map<number, number>()
  let lineStart = 0
  for (let line = 0; line < MaxDetectionLines && lineStart <= content.length; line += 1) {
    const newline = content.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? content.length : newline
    const text = content.slice(lineStart, lineEnd)
    lineStart = lineEnd + 1
    const indent = /^[ \t]*/u.exec(text)![0]
    if (text.trimEnd().length === 0) {
      if (newline < 0) break
      continue
    }
    if (indent.startsWith('\t')) {
      tabLines += 1
      previousSpaces = null
    } else {
      const spaces = indent.includes('\t') ? null : indent.length
      if (spaces) spaceLines += 1
      if (spaces !== null && previousSpaces !== null && spaces > previousSpaces) {
        const increase = spaces - previousSpaces
        if (DetectableSpaceSizes.includes(increase)) increases.set(increase, (increases.get(increase) ?? 0) + 1)
      }
      previousSpaces = spaces
    }
    if (newline < 0) break
  }

  if (tabLines > 0 && tabLines >= spaceLines) return { style: 'tab', size: DefaultWorkbenchTabSize }
  let best: Nullable<[number, number]> = null
  for (const [size, count] of increases)
    if (!best || count > best[1] || (count === best[1] && size < best[0])) best = [size, count]
  return best ? { style: 'space', size: best[0] } : null
}
