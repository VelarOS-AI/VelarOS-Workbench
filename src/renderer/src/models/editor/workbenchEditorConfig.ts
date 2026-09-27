/** 一份 `.editorconfig`：`root = true` 表示不再往上找；各节按出现顺序，后面的覆盖前面的。 */
export interface WorkbenchEditorConfigFile {
  root: boolean
  sections: WorkbenchEditorConfigSection[]
}

interface WorkbenchEditorConfigSection {
  matches: (relativePath: string) => boolean
  properties: ReadonlyMap<string, string>
}

/** 编辑器用到的几项；没写（或写了 `unset`）的不出现。 */
export interface WorkbenchEditorConfigProperties {
  indentStyle?: 'space' | 'tab'
  /** 一级缩进的宽度；`tab` 表示跟制表符宽度一致。 */
  indentSize?: number | 'tab'
  tabWidth?: number
  /** 保存时去掉行尾空白。 */
  trimTrailingWhitespace?: boolean
  /** 保存时保证文件以换行结尾（false 表示去掉结尾的换行）。 */
  insertFinalNewline?: boolean
}

/** 从文件往上找到的一份配置：`directory` 是它所在的目录（相对项目根，根目录为空串）。 */
export interface WorkbenchEditorConfigLocation {
  directory: string
  file: WorkbenchEditorConfigFile
}

const EditorConfigFileName = '.editorconfig'
/** 数字范围 `{1..3}` 最多展开这么多个数，再大就按任意整数算。 */
const MaxExpandedNumericRange = 1000

/** 文件所在目录一路往上到项目根，每一层可能有一份 `.editorconfig`（最近的在前）。 */
export function listWorkbenchEditorConfigPaths(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  const paths: string[] = []
  for (let depth = parts.length; depth >= 0; depth -= 1)
    paths.push([...parts.slice(0, depth), EditorConfigFileName].join('/'))
  return paths
}

export function parseWorkbenchEditorConfig(text: string): WorkbenchEditorConfigFile {
  const file: WorkbenchEditorConfigFile = { root: false, sections: [] }
  let current: Nullable<{ glob: string; properties: Map<string, string> }> = null
  const finish = (): void => {
    if (current)
      file.sections.push({ matches: compileEditorConfigGlob(current.glob), properties: current.properties })
  }

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(.+)\]$/u.exec(line)
    if (section) {
      finish()
      current = { glob: section[1]!, properties: new Map() }
      continue
    }
    const separator = line.search(/[=:]/u)
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (current) current.properties.set(key, value)
    else if (key === 'root') file.root = value.toLowerCase() === 'true'
  }
  finish()
  return file
}

/**
 * 算出一个文件生效的配置。`locations` 最近的在前；遇到 `root = true` 的那份就不再往上。越近的配置、同一份里越靠后的节
 * 优先级越高。
 */
export function resolveWorkbenchEditorConfig(
  locations: readonly WorkbenchEditorConfigLocation[],
  path: string
): WorkbenchEditorConfigProperties {
  const rootIndex = locations.findIndex((location) => location.file.root)
  const applicable = rootIndex < 0 ? locations : locations.slice(0, rootIndex + 1)
  const merged = new Map<string, string>()
  for (const location of [...applicable].reverse()) {
    const relativePath = location.directory ? path.slice(location.directory.length + 1) : path
    for (const section of location.file.sections)
      if (section.matches(relativePath))
        for (const [key, value] of section.properties) merged.set(key, value)
  }

  const properties: WorkbenchEditorConfigProperties = {}
  const indentStyle = merged.get('indent_style')?.toLowerCase()
  if (indentStyle === 'space' || indentStyle === 'tab') properties.indentStyle = indentStyle
  const indentSize = merged.get('indent_size')?.toLowerCase()
  if (indentSize === 'tab') properties.indentSize = 'tab'
  else if (indentSize) {
    const size = positiveInteger(indentSize)
    if (size) properties.indentSize = size
  }
  const tabWidth = positiveInteger(merged.get('tab_width') ?? '')
  if (tabWidth) properties.tabWidth = tabWidth
  const trimTrailingWhitespace = booleanValue(merged.get('trim_trailing_whitespace'))
  if (trimTrailingWhitespace !== undefined) properties.trimTrailingWhitespace = trimTrailingWhitespace
  const insertFinalNewline = booleanValue(merged.get('insert_final_newline'))
  if (insertFinalNewline !== undefined) properties.insertFinalNewline = insertFinalNewline
  return properties
}

function booleanValue(value: string | undefined): boolean | undefined {
  const normalized = value?.toLowerCase()
  return normalized === 'true' ? true : normalized === 'false' ? false : undefined
}

function positiveInteger(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined
  const number = Number(value)
  return number > 0 && number <= 32 ? number : undefined
}

/**
 * 把节名（EditorConfig 的通配写法）编译成匹配函数，参数是相对这份配置所在目录的路径。节名里没有 `/` 时匹配任意
 * 目录下的文件名；有 `/` 时从配置所在目录算起。
 */
function compileEditorConfigGlob(glob: string): (relativePath: string) => boolean {
  const anchored = glob.includes('/')
  const body = anchored ? glob.replace(/^\//u, '') : `**/${glob}`
  let expression: RegExp
  try {
    expression = new RegExp(`^${translateGlob(body)}$`, 'u')
  } catch {
    return () => false
  }
  return (relativePath) => expression.test(relativePath)
}

function translateGlob(glob: string): string {
  let result = ''
  for (let index = 0; index < glob.length; ) {
    const char = glob[index]!
    if (char === '\\') {
      result += escapeRegExp(glob[index + 1] ?? '\\')
      index += 2
    } else if (char === '*' && glob[index + 1] === '*') {
      // `**/` 也能一层目录都不跨：`**/a.ts` 匹配根目录下的 a.ts。
      if (glob[index + 2] === '/') {
        result += '(?:.*/)?'
        index += 3
      } else {
        result += '.*'
        index += 2
      }
    } else if (char === '*') {
      result += '[^/]*'
      index += 1
    } else if (char === '?') {
      result += '[^/]'
      index += 1
    } else if (char === '[') {
      const close = glob.indexOf(']', index + 2)
      if (close < 0) {
        result += '\\['
        index += 1
        continue
      }
      const content = glob.slice(index + 1, close)
      const negated = content.startsWith('!')
      const members = (negated ? content.slice(1) : content).replace(/[\\\]^]/gu, (match) => `\\${match}`)
      result += negated ? `[^/${members}]` : `[${members}]`
      index = close + 1
    } else if (char === '{') {
      const close = findClosingBrace(glob, index)
      if (close < 0) {
        result += '\\{'
        index += 1
        continue
      }
      result += translateBraces(glob.slice(index + 1, close))
      index = close + 1
    } else {
      result += escapeRegExp(char)
      index += 1
    }
  }
  return result
}

/** `{a,b}` 是几选一，`{1..3}` 是数字范围；都不是的按字面匹配花括号。 */
function translateBraces(content: string): string {
  const range = /^([+-]?\d+)\.\.([+-]?\d+)$/u.exec(content)
  if (range) {
    const from = Number(range[1])
    const to = Number(range[2])
    const [low, high] = from <= to ? [from, to] : [to, from]
    if (high - low > MaxExpandedNumericRange) return '[+-]?\\d+'
    return `(?:${Array.from({ length: high - low + 1 }, (_, offset) => String(low + offset)).join('|')})`
  }
  const alternatives = splitTopLevel(content)
  if (alternatives.length < 2) return `\\{${translateGlob(content)}\\}`
  return `(?:${alternatives.map(translateGlob).join('|')})`
}

function findClosingBrace(glob: string, open: number): number {
  let depth = 0
  for (let index = open; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '\\') index += 1
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return index
  }
  return -1
}

function splitTopLevel(content: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (char === '\\') index += 1
    else if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(content.slice(start, index))
      start = index + 1
    }
  }
  parts.push(content.slice(start))
  return parts
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')
}
