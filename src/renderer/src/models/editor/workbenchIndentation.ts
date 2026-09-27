import type { WorkbenchEditorConfigProperties } from './workbenchEditorConfig'

/** 一个文件的缩进：用空格还是制表符、一级几格，以及制表符显示多宽。 */
export interface WorkbenchIndentation {
  style: 'space' | 'tab'
  /** 一级缩进的宽度（用制表符时就是制表符宽度）。 */
  size: number
  tabSize: number
  /** 从哪来的：`.editorconfig`、按正文识别，还是语言默认。 */
  source: 'editorconfig' | 'detected' | 'default'
}

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
const DefaultTabSize = 4

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
    if (indent.length === text.trimEnd().length) {
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

  if (tabLines > 0 && tabLines >= spaceLines) return { style: 'tab', size: DefaultTabSize }
  let best: Nullable<[number, number]> = null
  for (const [size, count] of increases)
    if (!best || count > best[1] || (count === best[1] && size < best[0])) best = [size, count]
  return best ? { style: 'space', size: best[0] } : null
}

/** 语言的默认缩进：Python 四个空格，Makefile、Go 用制表符，其余两个空格。 */
export function defaultWorkbenchIndentation(path: Nullable<string>): WorkbenchIndentation {
  const name = (path?.split('/').at(-1) ?? '').toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  if (name === 'makefile' || name === 'gnumakefile' || extension === 'mk' || extension === 'go')
    return { style: 'tab', size: DefaultTabSize, tabSize: DefaultTabSize, source: 'default' }
  if (extension === 'py' || extension === 'pyi')
    return { style: 'space', size: 4, tabSize: 4, source: 'default' }
  return { style: 'space', size: 2, tabSize: 2, source: 'default' }
}

/** `.editorconfig` 写了的优先，其次按正文识别，最后用语言默认。 */
export function resolveWorkbenchIndentation({
  path,
  detected,
  editorConfig,
}: {
  path: Nullable<string>
  detected: Nullable<WorkbenchDetectedIndentation>
  editorConfig: Nullable<WorkbenchEditorConfigProperties>
}): WorkbenchIndentation {
  const fallback = defaultWorkbenchIndentation(path)
  const configured = !!editorConfig && (!!editorConfig.indentStyle || !!editorConfig.indentSize)
  const style = editorConfig?.indentStyle ?? detected?.style ?? fallback.style
  const configuredSize = editorConfig?.indentSize === 'tab' ? editorConfig.tabWidth : editorConfig?.indentSize
  const source = configured ? 'editorconfig' : detected ? 'detected' : 'default'

  if (style === 'tab') {
    const tabSize = editorConfig?.tabWidth ?? configuredSize ?? DefaultTabSize
    return { style, size: tabSize, tabSize, source }
  }
  const size =
    configuredSize ?? (detected?.style === 'space' ? detected.size : undefined) ?? (fallback.style === 'space' ? fallback.size : 2)
  return { style, size, tabSize: editorConfig?.tabWidth ?? size, source }
}

/** 按一次 Tab、回车自动缩进时插入的文本。 */
export function workbenchIndentUnit(indentation: WorkbenchIndentation): string {
  return indentation.style === 'tab' ? '\t' : ' '.repeat(indentation.size)
}
