/**
 * 快速打开（⌘P）的纯逻辑：输入怎么读、文件按名字怎么打分排序、最近打开的文件怎么排。组件只管呈现与按键。
 *
 * 输入的几种写法（同 VS Code）：
 * - `名字`：按文件名模糊匹配整个项目的文件，空格隔开的几段要都命中；
 * - `名字:行` / `名字:行:列`（列也可以用逗号隔开）：打开选中的文件并跳到那里；
 * - `:行` / `:行:列`：在当前文件里跳到那一行；
 * - `>命令`：命令面板。
 *
 * 文件排序：整条路径一字不差 > 文件名以输入开头 > 文件名模糊命中 > 路径模糊命中（多段输入分数相加）；
 * 最近打开过的文件在同一档里往前提。同分时文件名短的在前，再比路径长短。
 */
import {
  isWorkbenchFuzzySubsequence,
  scoreWorkbenchFuzzy,
} from '../shared/workbenchFuzzyScore'

export type WorkbenchQuickOpenMode = 'files' | 'line' | 'commands'

export interface WorkbenchQuickOpenQuery {
  mode: WorkbenchQuickOpenMode
  /** 去掉模式前缀和 `:行:列` 后缀后的输入，已去掉首尾空白。 */
  text: string
  /** `名字:行[:列]` 或 `:行[:列]` 里的行列（从 1 起）；没写或写得不对时为 null。 */
  line: Nullable<number>
  column: Nullable<number>
}

export interface WorkbenchQuickOpenFileItem {
  path: string
  name: string
  /** 所在目录（相对项目根）；项目根下的文件为空串。 */
  directory: string
  /** 文件名里命中的字符下标。 */
  nameMatches: readonly number[]
  /** 目录里命中的字符下标。 */
  directoryMatches: readonly number[]
  isOpen: boolean
}

export interface WorkbenchQuickOpenPathScore {
  score: number
  nameMatches: number[]
  directoryMatches: number[]
}

export const WorkbenchQuickOpenCommandPrefix = '>'
export const WorkbenchQuickOpenLinePrefix = ':'

const DefaultFileResultLimit = 50
/** 整条路径一字不差。 */
const PathIdentityScore = 1 << 18
/** 文件名以输入开头；再按输入占文件名的比例加 0–100 分。 */
const NamePrefixScore = 1 << 17
/** 文件名模糊命中；再加模糊分。路径命中只有模糊分，永远排在文件名命中之后。 */
const NameMatchScore = 1 << 16
/** 最近打开的文件：最近的一个加这么多，往后每个少 2 分，最少加 10 分。只在同一档里往前提。 */
const RecentBoostMax = 40
const RecentBoostStep = 2
const RecentBoostMin = 10

// 行列后面多敲的一个分隔符（还没敲完列号）不算错。
const PositionPattern = /^(\d+)(?:\s*[:,]\s*(\d+))?\s*[:,]?$/
const PathPositionPattern = /^(.+?):(\d+)(?:\s*[:,]\s*(\d+))?\s*[:,]?$/

function toPosition(value: LooseOptional<string>): Nullable<number> {
  if (!value) return null
  return Math.max(1, Number.parseInt(value, 10))
}

export function parseWorkbenchQuickOpenQuery(input: string): WorkbenchQuickOpenQuery {
  const trimmed = input.trim()
  if (trimmed.startsWith(WorkbenchQuickOpenCommandPrefix))
    return { mode: 'commands', text: trimmed.slice(1).trim(), line: null, column: null }

  if (trimmed.startsWith(WorkbenchQuickOpenLinePrefix)) {
    const text = trimmed.slice(1).trim()
    const match = PositionPattern.exec(text)
    return { mode: 'line', text, line: toPosition(match?.[1]), column: toPosition(match?.[2]) }
  }

  const match = PathPositionPattern.exec(trimmed)
  if (match?.[1].trim())
    return {
      mode: 'files',
      text: match[1].trim(),
      line: toPosition(match[2]),
      column: toPosition(match[3]),
    }

  // `名字:` 是正要敲行号：先照 `名字` 找，结果不因为多了个冒号一下子全没了。
  const text = trimmed.length > 1 && trimmed.endsWith(':') ? trimmed.slice(0, -1).trim() : trimmed
  return { mode: 'files', text, line: null, column: null }
}

interface PreparedFile {
  path: string
  lowerPath: string
  name: string
  lowerName: string
  /** 文件名去掉最后一个扩展名的长度（`.env` 这类点号开头的名字整个算）。 */
  stemLength: number
  /** 文件名在路径里从哪开始。 */
  nameStart: number
}

interface PreparedPiece {
  text: string
  lower: string
  hasSeparator: boolean
}

function prepareFile(path: string): PreparedFile {
  const nameStart = path.lastIndexOf('/') + 1
  const name = path.slice(nameStart)
  const extensionIndex = name.lastIndexOf('.')
  return {
    path,
    lowerPath: path.toLowerCase(),
    name,
    lowerName: name.toLowerCase(),
    stemLength: extensionIndex > 0 ? extensionIndex : name.length,
    nameStart,
  }
}

interface PreparedFileList {
  files: PreparedFile[]
  paths: ReadonlySet<string>
}

// 同一份文件清单只准备一次：每敲一个字都要把整份清单过一遍。
const preparedFileLists = new WeakMap<readonly string[], PreparedFileList>()

function prepareFileList(files: readonly string[]): PreparedFileList {
  const cached = preparedFileLists.get(files)
  if (cached) return cached

  const prepared = { files: files.map(prepareFile), paths: new Set(files) }
  preparedFileLists.set(files, prepared)
  return prepared
}

function preparePieces(text: string): PreparedPiece[] {
  return text
    .replace(/\\/g, '/')
    .split(/\s+/)
    .filter(Boolean)
    .map((piece) => ({ text: piece, lower: piece.toLowerCase(), hasSeparator: piece.includes('/') }))
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index)
}

function scorePiece(file: PreparedFile, piece: PreparedPiece): Nullable<WorkbenchQuickOpenPathScore> {
  if (piece.lower === file.lowerPath)
    return {
      score: PathIdentityScore,
      nameMatches: range(0, file.name.length),
      directoryMatches: range(0, Math.max(0, file.nameStart - 1)),
    }

  if (!piece.hasSeparator) {
    if (file.lowerName.startsWith(piece.lower)) {
      // 输入盖住了整个主名（`index` 之于 `index.ts`）算满分，否则按占文件名的比例。
      const boost =
        piece.lower.length >= file.stemLength
          ? 100
          : Math.round((piece.lower.length / file.name.length) * 100)
      return {
        score: NamePrefixScore + boost,
        nameMatches: range(0, piece.lower.length),
        directoryMatches: [],
      }
    }

    const nameMatch = scoreWorkbenchFuzzy(file.name, piece.text, {
      target: file.lowerName,
      query: piece.lower,
    })
    if (nameMatch)
      return { score: NameMatchScore + nameMatch.score, nameMatches: nameMatch.positions, directoryMatches: [] }
  }

  const pathMatch = scoreWorkbenchFuzzy(file.path, piece.text, {
    target: file.lowerPath,
    query: piece.lower,
  })
  if (!pathMatch) return null

  return {
    score: pathMatch.score,
    nameMatches: pathMatch.positions
      .filter((position) => position >= file.nameStart)
      .map((position) => position - file.nameStart),
    // 目录与文件名之间的 `/` 两边都不显示，命中了也不标。
    directoryMatches: pathMatch.positions.filter((position) => position < file.nameStart - 1),
  }
}

function mergePositions(left: readonly number[], right: readonly number[]): number[] {
  if (left.length === 0) return [...right]
  if (right.length === 0) return [...left]
  return [...new Set([...left, ...right])].sort((a, b) => a - b)
}

function scorePreparedFile(
  file: PreparedFile,
  pieces: readonly PreparedPiece[]
): Nullable<WorkbenchQuickOpenPathScore> {
  let total: Nullable<WorkbenchQuickOpenPathScore> = null
  for (const piece of pieces) {
    if (!isWorkbenchFuzzySubsequence(file.lowerPath, piece.lower)) return null

    const pieceScore = scorePiece(file, piece)
    if (!pieceScore) return null

    total = total
      ? {
          score: total.score + pieceScore.score,
          nameMatches: mergePositions(total.nameMatches, pieceScore.nameMatches),
          directoryMatches: mergePositions(total.directoryMatches, pieceScore.directoryMatches),
        }
      : pieceScore
  }
  return total
}

/** 按输入给一个项目相对路径打分；不匹配返回 null。`query` 是快速打开 `files` 模式下的 `text`。 */
export function scoreWorkbenchQuickOpenPath(
  path: string,
  query: string
): Nullable<WorkbenchQuickOpenPathScore> {
  const pieces = preparePieces(query)
  if (pieces.length === 0) return null

  return scorePreparedFile(prepareFile(path), pieces)
}

/** 最近打开的文件按新旧排好的名次（当前文件不算：跳去当前文件用不着快速打开）。 */
function buildRecentRanks(
  recentPaths: readonly string[],
  activePath: Nullable<string>
): Map<string, number> {
  const ranks = new Map<string, number>()
  for (const path of recentPaths) {
    if (path !== activePath && !ranks.has(path)) ranks.set(path, ranks.size)
  }
  return ranks
}

function recentBoost(rank: LooseOptional<number>): number {
  if (rank === undefined || rank === null) return 0
  return Math.max(RecentBoostMin, RecentBoostMax - rank * RecentBoostStep)
}

function toFileItem(
  file: Pick<PreparedFile, 'path' | 'name' | 'nameStart'>,
  matches: Pick<WorkbenchQuickOpenPathScore, 'nameMatches' | 'directoryMatches'>,
  isOpen: boolean
): WorkbenchQuickOpenFileItem {
  return {
    path: file.path,
    name: file.name,
    directory: file.path.slice(0, Math.max(0, file.nameStart - 1)),
    nameMatches: matches.nameMatches,
    directoryMatches: matches.directoryMatches,
    isOpen,
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** 按输入找文件：整份清单加上打开着的标签（清单还没读到或被截断时它们也找得到）。 */
export function buildWorkbenchQuickOpenFileItems({
  files,
  openTabPaths,
  recentPaths,
  activePath,
  query,
  limit = DefaultFileResultLimit,
}: {
  files: readonly string[]
  openTabPaths: readonly string[]
  recentPaths: readonly string[]
  activePath: Nullable<string>
  query: string
  limit?: number
}): WorkbenchQuickOpenFileItem[] {
  const pieces = preparePieces(query)
  if (pieces.length === 0) return []

  const listed = prepareFileList(files)
  const candidates = [
    ...listed.files,
    ...openTabPaths.filter((path) => !listed.paths.has(path)).map(prepareFile),
  ]
  const openPaths = new Set(openTabPaths)
  const recentRanks = buildRecentRanks(recentPaths, activePath)
  const scored: Array<{ file: PreparedFile; score: number; matches: WorkbenchQuickOpenPathScore }> = []

  for (const file of candidates) {
    const matches = scorePreparedFile(file, pieces)
    if (!matches) continue

    scored.push({ file, score: matches.score + recentBoost(recentRanks.get(file.path)), matches })
  }

  return scored
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.file.name.length - right.file.name.length ||
        left.file.path.length - right.file.path.length ||
        compareText(left.file.path, right.file.path)
    )
    .slice(0, Math.max(1, limit))
    .map(({ file, matches }) => toFileItem(file, matches, openPaths.has(file.path)))
}

/**
 * 输入为空时列出的最近打开的文件：最近的在前，打开着但没记下的标签接在后面，当前文件放到最后
 * （同 VS Code：打开快速打开直接回车，回到的是上一个文件）。已经不在项目里的文件不列——只有拿到的是
 * 完整清单时才知道；清单还没读到或被截断时照列。
 */
export function buildWorkbenchQuickOpenRecentItems({
  recentPaths,
  openTabPaths,
  activePath,
  files,
  limit = DefaultFileResultLimit,
}: {
  recentPaths: readonly string[]
  openTabPaths: readonly string[]
  activePath: Nullable<string>
  /** 完整的文件清单；没有（还没读到、被截断）时为 null。 */
  files: Nullable<readonly string[]>
  limit?: number
}): WorkbenchQuickOpenFileItem[] {
  const openPaths = new Set(openTabPaths)
  const existing = files ? prepareFileList(files).paths : null
  const ordered = [...new Set([...recentPaths, ...openTabPaths])].filter(
    (path) => openPaths.has(path) || !existing || existing.has(path)
  )
  const others = ordered.filter((path) => path !== activePath)
  const paths = ordered.length > others.length ? [...others, activePath!] : others

  return paths
    .slice(0, Math.max(1, limit))
    .map((path) =>
      toFileItem(prepareFile(path), { nameMatches: [], directoryMatches: [] }, openPaths.has(path))
    )
}
