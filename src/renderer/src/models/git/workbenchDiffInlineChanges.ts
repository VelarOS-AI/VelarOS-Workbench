import type { WorkbenchUnifiedDiffRow } from './workbenchGitDiffModel'

/** 一行里变了的一段：相对这一行正文的 [from, to)，UTF-16 下标（与 CodeMirror 的位置同一种算法）。 */
export interface WorkbenchDiffInlineRange {
  from: number
  to: number
}

/** 差异行的下标 → 这一行里变了的那几段。不在里面的行没有行内变化可标（整行新增、整行删除、没比）。 */
export type WorkbenchDiffInlineChanges = ReadonlyMap<number, readonly WorkbenchDiffInlineRange[]>

/**
 * 行内比较的工作量上限，按「格」算：一块改动里旧的一侧的词数 × 新的一侧的词数（去掉两头相同的之后）。
 * 大差异要保持跟手：超过上限的块不比，只有整行的底色。
 */
export interface WorkbenchDiffInlineLimits {
  /** 一块改动（连着的删除行和紧跟着的新增行）最多比这么多格。 */
  maxBlockCells: number
  /** 整份差异加起来最多比这么多格；用完之后后面的块都不比。 */
  maxTotalCells: number
}

/** 一块约 630×630 个词（几十行对几十行）以内才比；整份差异至多十块这么大的量，几十毫秒之内。 */
export const WorkbenchDiffInlineDefaultLimits: WorkbenchDiffInlineLimits = {
  maxBlockCells: 400_000,
  maxTotalCells: 4_000_000,
}

/**
 * 一块改动两侧加起来超过这么多字就不拆词。一行很长、只改了一个词的（压缩过的 JSON）在这个数以内，
 * 两头相同的去掉之后只剩一点要比，照样标得出。
 */
const MaxBlockCharacters = 400_000

/** 一行里没变的实字（非空白）不到这个比例：当作整行都换了，不标行内变化，整行的底色已经够了。 */
const MinUnchangedShare = 0.2

const CjkCharacter = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]`
/**
 * 拆词：一串字母、数字、下划线是一个词；汉字、假名之间没有空格分词，一个字算一个；一串空白算一个；
 * 其余的符号一个一个。
 */
const TokenPattern = new RegExp(
  String.raw`${CjkCharacter}|(?:(?!${CjkCharacter})[\p{L}\p{N}_])+|\s+|\S`,
  'gu'
)

interface InlineToken {
  text: string
  /** 所在差异行的下标；行与行之间的换行是 -1。 */
  row: number
  from: number
  to: number
  /** 不是空白。 */
  solid: boolean
}

const LineBreak: InlineToken = { text: '\n', row: -1, from: 0, to: 0, solid: false }

function tokenizeRows(
  rows: readonly WorkbenchUnifiedDiffRow[],
  start: number,
  end: number
): InlineToken[] {
  const tokens: InlineToken[] = []
  for (let row = start; row < end; row += 1) {
    if (row > start) tokens.push(LineBreak)
    for (const match of rows[row].text.matchAll(TokenPattern)) {
      const text = match[0]
      tokens.push({
        text,
        row,
        from: match.index,
        to: match.index + text.length,
        solid: text.trim().length > 0,
      })
    }
  }
  return tokens
}

/**
 * 两串词的最长公共子序列，在 `oldKept` / `newKept` 里把公共的词标成 1。只比 [prefix, 长度 - suffix) 这一段，
 * 两头相同的已经由调用方标好。
 */
function markCommonTokens(
  oldTokens: readonly InlineToken[],
  newTokens: readonly InlineToken[],
  prefix: number,
  suffix: number,
  oldKept: Uint8Array,
  newKept: Uint8Array
): void {
  const oldCount = oldTokens.length - prefix - suffix
  const newCount = newTokens.length - prefix - suffix
  if (oldCount === 0 || newCount === 0) return
  const width = newCount + 1
  // lengths[i * width + j]：旧的前 i 个词与新的前 j 个词的最长公共子序列有多长。
  const lengths = new Uint32Array((oldCount + 1) * width)
  for (let i = 1; i <= oldCount; i += 1) {
    const text = oldTokens[prefix + i - 1].text
    for (let j = 1; j <= newCount; j += 1) {
      lengths[i * width + j] =
        text === newTokens[prefix + j - 1].text
          ? lengths[(i - 1) * width + j - 1] + 1
          : Math.max(lengths[(i - 1) * width + j], lengths[i * width + j - 1])
    }
  }
  let i = oldCount
  let j = newCount
  while (i > 0 && j > 0) {
    if (oldTokens[prefix + i - 1].text === newTokens[prefix + j - 1].text) {
      oldKept[prefix + i - 1] = 1
      newKept[prefix + j - 1] = 1
      i -= 1
      j -= 1
    } else if (lengths[(i - 1) * width + j] >= lengths[i * width + j - 1]) i -= 1
    else j -= 1
  }
}

/** 把一侧没标成公共的词按行收成一段段；两段之间只隔着空白的并成一段。整行都换了的行不收。 */
function collectRanges(
  rows: readonly WorkbenchUnifiedDiffRow[],
  tokens: readonly InlineToken[],
  kept: Uint8Array,
  changes: Map<number, WorkbenchDiffInlineRange[]>
): void {
  let index = 0
  while (index < tokens.length) {
    const { row } = tokens[index]
    if (row < 0) {
      index += 1
      continue
    }
    const text = rows[row].text
    const ranges: WorkbenchDiffInlineRange[] = []
    let solidTotal = 0
    let solidChanged = 0
    for (; index < tokens.length && tokens[index].row === row; index += 1) {
      const token = tokens[index]
      const solid = token.solid ? token.to - token.from : 0
      solidTotal += solid
      if (kept[index]) continue
      solidChanged += solid
      const last = ranges.at(-1)
      if (last && text.slice(last.to, token.from).trim() === '') last.to = token.to
      else ranges.push({ from: token.from, to: token.to })
    }
    if (ranges.length === 0) continue
    if (solidTotal > 0 && solidTotal - solidChanged < solidTotal * MinUnchangedShare) continue
    changes.set(row, ranges)
  }
}

/** 比一块改动（[deletionStart, additionStart) 是删除行，[additionStart, end) 是新增行）；返回用掉的格数。 */
function compareBlock(
  rows: readonly WorkbenchUnifiedDiffRow[],
  deletionStart: number,
  additionStart: number,
  end: number,
  maxCells: number,
  changes: Map<number, WorkbenchDiffInlineRange[]>
): number {
  // 拆词之前先看字数：成千上万行的一整块，光拆词就要很久，而它反正过不了格数的上限。
  let characters = 0
  for (let row = deletionStart; row < end; row += 1) characters += rows[row].text.length
  if (characters > MaxBlockCharacters) return 0

  const oldTokens = tokenizeRows(rows, deletionStart, additionStart)
  const newTokens = tokenizeRows(rows, additionStart, end)
  const shorter = Math.min(oldTokens.length, newTokens.length)
  let prefix = 0
  while (prefix < shorter && oldTokens[prefix].text === newTokens[prefix].text) prefix += 1
  let suffix = 0
  while (
    suffix < shorter - prefix &&
    oldTokens[oldTokens.length - 1 - suffix].text === newTokens[newTokens.length - 1 - suffix].text
  )
    suffix += 1

  const cells = (oldTokens.length - prefix - suffix) * (newTokens.length - prefix - suffix)
  if (cells > maxCells) return 0

  const oldKept = new Uint8Array(oldTokens.length)
  const newKept = new Uint8Array(newTokens.length)
  oldKept.fill(1, 0, prefix)
  newKept.fill(1, 0, prefix)
  oldKept.fill(1, oldTokens.length - suffix)
  newKept.fill(1, newTokens.length - suffix)
  markCommonTokens(oldTokens, newTokens, prefix, suffix, oldKept, newKept)
  collectRanges(rows, oldTokens, oldKept, changes)
  collectRanges(rows, newTokens, newKept, changes)
  return cells
}

/**
 * 改过的行里具体变了哪几个词。一块改动是连着的删除行加上紧跟着的新增行：把两边各拆成词（跨行一起比，
 * 行数对不上——一行拆成两行、中间插了一行——也对得齐），求最长公共子序列，公共之外的就是变了的。
 *
 * 只有删除或只有新增的块没有可比的；整行都换了的行不标（底色已经说明了）。工作量有上限（见
 * {@link WorkbenchDiffInlineLimits}）：超过的块不比，所以再大的差异这里也只花有限的时间。
 */
export function computeWorkbenchDiffInlineChanges(
  rows: readonly WorkbenchUnifiedDiffRow[],
  limits: WorkbenchDiffInlineLimits = WorkbenchDiffInlineDefaultLimits
): WorkbenchDiffInlineChanges {
  const changes = new Map<number, WorkbenchDiffInlineRange[]>()
  let remaining = limits.maxTotalCells
  let index = 0
  while (index < rows.length && remaining > 0) {
    if (rows[index].kind !== 'deletion') {
      index += 1
      continue
    }
    const deletionStart = index
    while (index < rows.length && rows[index].kind === 'deletion') index += 1
    const additionStart = index
    while (index < rows.length && rows[index].kind === 'addition') index += 1
    if (index === additionStart) continue
    remaining -= compareBlock(
      rows,
      deletionStart,
      additionStart,
      index,
      Math.min(limits.maxBlockCells, remaining),
      changes
    )
  }
  return changes
}
