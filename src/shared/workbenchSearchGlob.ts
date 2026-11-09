/**
 * 项目搜索的「包含 / 排除的文件」，写法与 VS Code 的搜索面板一致：
 * - 逗号分隔多个模式；花括号里的逗号不算（`*.{ts,tsx}`）。
 * - `./`（或 `/`）开头的从工程根目录算；其余的在任何一层都算，等于前面加了 `**\/`。
 * - 模式对上的是目录时，目录里的文件都算：`src`、`src/`、`src/**` 是一个意思。
 * - `*` 不跨目录，`**` 跨任意层，`?` 是一个字符，`{a,b}` 任选其一，`[abc]` / `[!abc]` 是字符集。
 * - 不分大小写；反斜杠当作路径分隔符。
 *
 * 路径都是工程相对路径，用 `/` 分隔。
 */

export interface WorkbenchSearchPathFilter {
  include: RegExp[]
  exclude: RegExp[]
}

/** 一个模式的花括号最多展开成这么多个，防止 `{a,b}{c,d}…` 失控。 */
const MaxBraceExpansions = 64
const RegExpSpecialCharacters = /[$()*+.?[\\\]^{|}]/gu

/** 拆出逗号分隔的各个模式（去掉空白与空项）。 */
export function splitWorkbenchSearchGlobs(text: string): string[] {
  const patterns: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '{') depth += 1
    else if (char === '}' && depth > 0) depth -= 1
    if (char === ',' && depth === 0) {
      patterns.push(current)
      current = ''
      continue
    }
    current += char
  }
  patterns.push(current)
  return patterns.map((pattern) => pattern.trim()).filter(Boolean)
}

export function compileWorkbenchSearchPathFilter(
  include: string,
  exclude: string
): WorkbenchSearchPathFilter {
  return {
    include: splitWorkbenchSearchGlobs(include).map(compileWorkbenchSearchGlob),
    exclude: splitWorkbenchSearchGlobs(exclude).map(compileWorkbenchSearchGlob),
  }
}

/** 这个文件在不在搜索范围里：对上任一包含模式（没写包含模式就都算），且不对上任一排除模式。 */
export function isWorkbenchSearchPathIncluded(filter: WorkbenchSearchPathFilter, path: string): boolean {
  return (
    (filter.include.length === 0 || filter.include.some((pattern) => pattern.test(path)))
    && !filter.exclude.some((pattern) => pattern.test(path))
  )
}

/** 整个目录都被排除了：遍历时不用进去。 */
export function isWorkbenchSearchDirectoryExcluded(
  filter: WorkbenchSearchPathFilter,
  directoryPath: string
): boolean {
  return filter.exclude.some((pattern) => pattern.test(directoryPath))
}

/** 路径的排序键：按目录一层层比、不分大小写（`src/b.ts` 排在 `src-old/a.ts` 前面）。 */
export function workbenchSearchPathSortKey(path: string): string {
  return path.toLowerCase().replaceAll('/', '\u0000')
}

export function compareWorkbenchSearchPaths(left: string, right: string): number {
  const leftKey = workbenchSearchPathSortKey(left)
  const rightKey = workbenchSearchPathSortKey(right)
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function compileWorkbenchSearchGlob(glob: string): RegExp {
  const patterns = expandBraces(normalizeGlob(glob))
  try {
    return globRegExp(patterns.map((pattern) => globSource(pattern, true)))
  } catch {
    // 写不成正则的字符集（`[z-a]`）按字面的方括号算。
    return globRegExp(patterns.map((pattern) => globSource(pattern, false)))
  }
}

function globRegExp(sources: readonly string[]): RegExp {
  return new RegExp(`^(?:${sources.join('|')})(?:/.*)?$`, 'i')
}

function normalizeGlob(glob: string): string {
  let pattern = glob.replaceAll('\\', '/').trim()
  let anchored = false
  if (pattern.startsWith('./')) {
    pattern = pattern.slice(2)
    anchored = true
  } else if (pattern.startsWith('/')) {
    pattern = pattern.slice(1)
    anchored = true
  }
  pattern = pattern.replace(/\/+$/u, '')
  if (!pattern) return '**'

  return anchored || pattern.startsWith('**') ? pattern : `**/${pattern}`
}

/** 展开成对花括号；剩余预算传给递归，到上限就不再展开后续分支。不成对的花括号按字面算。 */
function expandBraces(pattern: string, budget = MaxBraceExpansions): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]

  let depth = 0
  let close = -1
  const commas: number[] = []
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    } else if (char === ',' && depth === 1) commas.push(index)
  }
  if (close === -1) return [pattern]

  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const alternatives: string[] = []
  let from = open + 1
  for (const comma of commas) {
    alternatives.push(pattern.slice(from, comma))
    from = comma + 1
  }
  alternatives.push(pattern.slice(from, close))
  const expanded: string[] = []
  for (const alternative of alternatives) {
    if (expanded.length === budget) break
    expanded.push(...expandBraces(`${prefix}${alternative}${suffix}`, budget - expanded.length))
  }
  return expanded
}

/**
 * 一个（已展开花括号的）模式的正则写法：`**` 整段时跨任意层，否则按段转。`characterClasses` 为 false 时
 * 方括号按字面算。
 */
function globSource(pattern: string, characterClasses: boolean): string {
  const segments = pattern.split('/').filter(Boolean)
  let source = ''
  let separated = false
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === '**') {
      while (segments[index + 1] === '**') index += 1
      if (index === segments.length - 1) return source + (separated ? '(?:/.*)?' : '.*')
      source += separated ? '(?:/.*)?/' : '(?:.*/)?'
      separated = false
      continue
    }
    if (separated) source += '/'
    source += segmentSource(segments[index]!, characterClasses)
    separated = true
  }
  return source
}

function segmentSource(segment: string, characterClasses: boolean): string {
  let source = ''
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!
    if (char === '*') {
      while (segment[index + 1] === '*') index += 1
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[' && characterClasses) {
      const close = segment.indexOf(']', index + 2)
      if (close === -1) {
        source += '\\['
        continue
      }
      let body = segment.slice(index + 1, close)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      source += `[${negated ? '^' : ''}${body.replace(/[\\\]^[]/gu, '\\$&')}]`
      index = close
    } else {
      source += char.replace(RegExpSpecialCharacters, '\\$&')
    }
  }
  return source
}
