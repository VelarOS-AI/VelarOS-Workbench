/**
 * 终端输出里的文件路径：找出看着像路径的片段（可以带行列），按会话目录解析成项目里的路径。找出来的只是候选，
 * 要主进程确认真有这个文件才画成链接，所以这里宁可多认，不怕认错。
 */

/** 终端一行里的一个文件路径：`start..end` 是它在这行文字里的位置（不含 end）。 */
export interface WorkbenchTerminalFileLink {
  start: number
  end: number
  path: string
  line?: number
  column?: number
}

/** 文件名里能有的字符（不含空白、引号、括号、冒号、逗号这些常用来隔开路径的符号）。 */
const NameChar = String.raw`[\p{L}\p{N}_@.+\-$]`
/** 一段文件名；Next.js 的 `[slug]`、`[...slug]` 这样成对的方括号也算。 */
const NameSegment = String.raw`(?:${NameChar}|\[${NameChar}+\])+`
/** 目录还可以是 Next.js 的路由分组 `(marketing)`。 */
const DirectorySegment = String.raw`(?:\(${NameChar}+\)|${NameSegment})`
const PathBody = String.raw`(?:[A-Za-z]:)?(?:~|\.{1,2})?[\\/]?(?:${DirectorySegment}[\\/])*${NameSegment}`
/**
 * 路径后面的行列：`:12`、`:12:5`（Node、ESLint、Vite、Rust、Go、栈追踪）、`(12,5)`、`(12)`（tsc、MSBuild）、
 * ` line 12`、` on line 12`（Perl、PHP）。
 */
const LocationSuffix = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|,? (?:on )?line (\d+))?`
/** 前面不能紧挨着文件名字符、路径分隔符或冒号：不从一个词、一个网址中间截出路径。 */
const FilePathPattern = new RegExp(
  String.raw`(?<![\p{L}\p{N}_@.+\-$/\\:])(${PathBody})${LocationSuffix}`,
  'gu'
)
/** Python 的栈：`File "/path/app.py", line 12`（路径可以有空格）。 */
const PythonFramePattern = /File "([^"]+)", line (\d+)/gu
/** Node ESM 的栈这样写文件：`file:///Users/me/app.mjs:12:5`。 */
const FileUrlPattern = /\bfile:\/\/[^\s'"<>()]+/giu
/** 别的网址交给网页链接，里面的路径不再当文件。 */
const UrlPattern = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu

/**
 * 找出一行终端输出里的文件路径。带目录的、带行号的都算；光秃秃一个名字要有扩展名（`ls` 列出的
 * `package.json`）。里面没有字母的（时间 `12:30:05`、地址 `127.0.0.1:3000`）不算。
 */
export function findWorkbenchTerminalFileLinks(text: string): WorkbenchTerminalFileLink[] {
  const links: WorkbenchTerminalFileLink[] = []
  const taken: Array<[number, number]> = []
  const isTaken = (start: number, end: number): boolean =>
    taken.some(([from, to]) => start < to && end > from)

  for (const match of text.matchAll(PythonFramePattern)) {
    taken.push([match.index, match.index + match[0].length])
    // `File "<frozen importlib._bootstrap>"` 这样的不是文件。
    if (match[1]!.startsWith('<')) continue
    const start = match.index + 'File "'.length
    links.push({ start, end: start + match[1]!.length, path: match[1]!, line: Number(match[2]) })
  }
  for (const match of text.matchAll(FileUrlPattern)) {
    taken.push([match.index, match.index + match[0].length])
    const url = match[0].replace(/[.,;:]+$/u, '')
    const link = parseFileUrl(url)
    if (link) links.push({ start: match.index, end: match.index + url.length, ...link })
  }
  for (const match of text.matchAll(UrlPattern)) {
    if (!isTaken(match.index, match.index + match[0].length))
      taken.push([match.index, match.index + match[0].length])
  }

  for (const match of text.matchAll(FilePathPattern)) {
    // 句末的点不是路径的一部分：`见 src/a.ts。`、`see src/a.ts.`。
    const path = match[1]!.replace(/\.+$/u, '')
    const hasLocation = match[1] === path && match.slice(2).some((group) => group !== undefined)
    const start = match.index
    const end = start + (hasLocation ? match[0].length : path.length)
    if (!path || !/\p{L}/u.test(path) || isTaken(start, end)) continue
    if (!/[\\/]/u.test(path) && !hasLocation && !/\.[A-Za-z][A-Za-z0-9]*$/u.test(path)) continue

    const line = hasLocation ? toPositiveNumber(match[2] ?? match[4] ?? match[6]) : undefined
    const column = hasLocation ? toPositiveNumber(match[3] ?? match[5]) : undefined
    links.push({ start, end, path, ...withLocation(line, column) })
  }
  return links.sort((left, right) => left.start - right.start)
}

function parseFileUrl(url: string): Nullable<Omit<WorkbenchTerminalFileLink, 'start' | 'end'>> {
  const match = /^file:\/\/[^/]*(\/.*?)(?::(\d+)(?::(\d+))?)?$/iu.exec(url)
  if (!match) return null
  const path = decodeFileUrlPath(match[1]!)
  return path ? { path, ...withLocation(toPositiveNumber(match[2]), toPositiveNumber(match[3])) } : null
}

/** `file://` 网址里的路径：解开 URL 编码；Windows 的 `/C:/x` 去掉开头的斜杠。 */
function decodeFileUrlPath(encoded: string): Nullable<string> {
  try {
    const path = decodeURIComponent(encoded)
    return /^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path
  } catch {
    // arch-guard:silent-catch-ok 编码坏掉的网址（落单的 `%`）就不当路径。
    return null
  }
}

function withLocation(line: number | undefined, column: number | undefined): Pick<WorkbenchTerminalFileLink, 'line' | 'column'> {
  if (line === undefined) return {}
  return column === undefined ? { line } : { line, column }
}

function toPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  return number > 0 ? number : undefined
}

/**
 * shell 用 OSC 7 报的当前目录（`file://主机/路径`）。报了就按它解析相对路径，没报就只能用会话的起始目录。
 */
export function parseWorkbenchTerminalCwdReport(data: string): Nullable<string> {
  const match = /^file:\/\/[^/]*(\/.*)$/iu.exec(data)
  return match ? decodeFileUrlPath(match[1]!) : null
}

/**
 * 按目录把路径解析成绝对路径（统一用 `/`，折掉 `.`、`..`）。`~` 开头的解析不了（renderer 不知道家目录），给 null。
 */
export function resolveWorkbenchTerminalLinkPath(directory: string, path: string): Nullable<string> {
  const normalized = path.replaceAll('\\', '/')
  if (normalized.startsWith('~')) return null
  const absolute =
    normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
      ? normalized
      : `${directory.replaceAll('\\', '/').replace(/\/+$/u, '')}/${normalized}`
  const drive = /^[A-Za-z]:/u.exec(absolute)?.[0] ?? ''
  const segments: string[] = []
  for (const segment of absolute.slice(drive.length).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `${drive}/${segments.join('/')}`
}

/**
 * 绝对路径相对项目根的路径；不在项目里给 null。macOS 上 `/tmp` 就是 `/private/tmp`，两种写法都认；
 * Windows 的盘符与路径不分大小写。
 */
export function toWorkbenchProjectRelativePath(projectRoot: string, absolutePath: string): Nullable<string> {
  const root = projectRoot.replaceAll('\\', '/').replace(/\/+$/u, '')
  const roots = [root, root.startsWith('/private/') ? root.slice('/private'.length) : `/private${root}`]
  const caseInsensitive = /^[A-Za-z]:\//u.test(root)
  for (const candidate of roots) {
    const prefix = `${candidate}/`
    const head = absolutePath.slice(0, prefix.length)
    if (caseInsensitive ? head.toLowerCase() === prefix.toLowerCase() : head === prefix)
      return absolutePath.slice(prefix.length) || null
  }
  return null
}

/**
 * 一个终端路径可能指的项目文件，按先后试：先按 shell 当前目录，再按项目根（`cd` 进子目录后打印的项目
 * 相对路径）。`git diff` 的 `a/`、`b/` 前缀也试一下去掉的。
 */
export function listWorkbenchTerminalLinkCandidates(projectRoot: string, cwd: string, path: string): string[] {
  const normalized = path.replaceAll('\\', '/')
  const paths = /^[ab]\/./u.test(normalized) ? [normalized, normalized.slice(2)] : [normalized]
  const candidates: string[] = []
  for (const candidatePath of paths) {
    for (const directory of [cwd, projectRoot]) {
      const absolute = resolveWorkbenchTerminalLinkPath(directory, candidatePath)
      const relative = absolute ? toWorkbenchProjectRelativePath(projectRoot, absolute) : null
      if (relative && !candidates.includes(relative)) candidates.push(relative)
    }
  }
  return candidates
}
