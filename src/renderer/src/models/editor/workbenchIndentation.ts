import type { ChangeSpec, EditorState } from '@codemirror/state'

import type { WorkbenchLanguageServiceEditFormat } from '@shared/contracts'

import type { WorkbenchEditorConfigProperties } from './workbenchEditorConfig'

/** 一个文件的缩进：用空格还是制表符、一级几格，以及制表符显示多宽。 */
export interface WorkbenchIndentation {
  style: 'space' | 'tab'
  /** 一级缩进的宽度（用制表符时就是制表符宽度）。 */
  size: number
  tabSize: number
  /** 从哪来的：用户在状态栏选的、`.editorconfig`、按正文识别，还是语言默认。 */
  source: 'override' | 'editorconfig' | 'detected' | 'default'
}

/** 用户在状态栏为一个文件选的缩进：压过 `.editorconfig` 和识别结果（空格时是一级几格，制表符时是显示宽度）。 */
export interface WorkbenchIndentationOverride {
  style: 'space' | 'tab'
  size: number
}

/** 状态栏缩进菜单交给编辑器的操作：改用某种缩进、把现有缩进转换过去、回到按内容识别。 */
export type WorkbenchIndentationChange =
  | { kind: 'use'; style: 'space' | 'tab'; size: number }
  | { kind: 'convert'; style: 'space' | 'tab' }
  | { kind: 'detect' }

export interface WorkbenchIndentationRequest {
  id: number
  change: WorkbenchIndentationChange
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

/** 用户在状态栏选的优先，其次 `.editorconfig` 写了的，再次按正文识别，最后用语言默认。 */
export function resolveWorkbenchIndentation({
  path,
  detected,
  editorConfig,
  override = null,
}: {
  path: Nullable<string>
  detected: Nullable<WorkbenchDetectedIndentation>
  editorConfig: Nullable<WorkbenchEditorConfigProperties>
  override?: Nullable<WorkbenchIndentationOverride>
}): WorkbenchIndentation {
  if (override) return { style: override.style, size: override.size, tabSize: override.size, source: 'override' }
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

/**
 * 这个文件的缩进，交给语言服务：它替用户写的代码（格式化、补全插入的整段代码）照这个排，
 * 而不是它自己的两格空格。
 */
export function toWorkbenchLanguageServiceEditFormat(
  indentation: WorkbenchIndentation
): WorkbenchLanguageServiceEditFormat {
  return {
    tabSize: indentation.tabSize,
    indentSize: indentation.size,
    insertSpaces: indentation.style === 'space',
  }
}

/**
 * 把每行开头的缩进换成新的写法（制表符按原来的显示宽度折算成列）：转成空格时每列一个空格，转成制表符时每
 * `target.size` 列一个制表符、零头补空格。只改确实变了的行。
 */
export function buildWorkbenchIndentationConversion(
  state: EditorState,
  target: WorkbenchIndentationOverride,
  currentTabSize: number
): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number)
    const indent = /^[ \t]*/u.exec(line.text)![0]
    if (!indent) continue
    let columns = 0
    for (const char of indent)
      columns = char === '\t' ? (Math.floor(columns / currentTabSize) + 1) * currentTabSize : columns + 1
    const next =
      target.style === 'tab'
        ? '\t'.repeat(Math.floor(columns / target.size)) + ' '.repeat(columns % target.size)
        : ' '.repeat(columns)
    if (next !== indent) changes.push({ from: line.from, to: line.from + indent.length, insert: next })
  }
  return changes
}
