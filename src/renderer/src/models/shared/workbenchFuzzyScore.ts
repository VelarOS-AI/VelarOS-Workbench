/**
 * 模糊匹配打分（快速打开的文件名、命令面板的命令名共用），思路同 VS Code / JetBrains：
 * 查询里的字符不分大小写、按顺序都出现在目标里就算匹配，不要求连着。
 *
 * 分数逐字符累加：
 * - 命中 +1，大小写也一样再 +1；
 * - 连着命中：接在上一个命中字符后面的，按已经连着的长度 ×5 加分，越长越值钱；
 * - 词首：目标开头 +8，路径分隔符 `/` 后 +5，`_ - . 空格` 等分隔符后 +4，驼峰的大写字母 +3
 *   （连着命中时不给驼峰分：`HTTP` 连着敲不该每个大写字母都加）。
 *
 * 在所有合法的对齐里取总分最高的一种（同分取靠前的），命中位置随它返回，用来高亮。
 */

export interface WorkbenchFuzzyMatch {
  score: number
  /** 命中字符在目标里的下标，升序。 */
  positions: number[]
}

/** 调用方已经算好的小写形式（打分热路径上免得每次重算）。 */
export interface WorkbenchFuzzyLowercase {
  target: string
  query: string
}

const ConsecutiveBonus = 5
const StartBonus = 8
const PathSeparatorBonus = 5
const WordSeparatorBonus = 4
const CamelCaseBonus = 3
const WordSeparators: ReadonlySet<string> = new Set(['_', '-', '.', ' ', '"', "'", ':'])
/** 不可达的格子：比任何合法总分都小，相加也不会溢出。 */
const NoScore = -1_000_000

// 打分矩阵按需扩容、反复复用：快速打开每敲一个字要给成千上万个文件打分，不能每次都分配。
let runIntercepts = new Int32Array(0)
let hullPrevious = new Int32Array(0)
let matchedRunStarts = new Int32Array(0)
let runPrefixEnds = new Int32Array(0)
let diagonalScores = new Int32Array(0)
let diagonalTails = new Int32Array(0)
let rowScores = new Int32Array(0)
let rowEnds = new Int32Array(0)

function ensureMatrixCapacity(size: number, targetLength: number): void {
  if (runIntercepts.length < size) {
    const capacity = Math.max(size, runIntercepts.length * 2, 256)
    runIntercepts = new Int32Array(capacity)
    hullPrevious = new Int32Array(capacity)
    matchedRunStarts = new Int32Array(capacity)
    runPrefixEnds = new Int32Array(capacity)
  }
  if (diagonalScores.length < targetLength) {
    const capacity = Math.max(targetLength, diagonalScores.length * 2, 256)
    diagonalScores = new Int32Array(capacity)
    diagonalTails = new Int32Array(capacity)
    rowScores = new Int32Array(capacity * 2)
    rowEnds = new Int32Array(capacity * 2)
  }
}

/** `query` 的字符按顺序都在 `target` 里（两者都应已是小写）：打分前的快速筛选。 */
export function isWorkbenchFuzzySubsequence(targetLower: string, queryLower: string): boolean {
  let queryIndex = 0
  for (let targetIndex = 0; targetIndex < targetLower.length; targetIndex += 1) {
    if (queryIndex === queryLower.length) break
    if (targetLower.charCodeAt(targetIndex) === queryLower.charCodeAt(queryIndex)) queryIndex += 1
  }
  return queryIndex === queryLower.length
}

function isUpperCaseLetter(character: LooseOptional<string>): boolean {
  return !!character && character !== character.toLowerCase() && character === character.toUpperCase()
}

function isLowerCaseLetter(character: LooseOptional<string>): boolean {
  return !!character && character !== character.toUpperCase() && character === character.toLowerCase()
}

/** 驼峰的词首：小写后面的大写（`quickOpen` 的 O），或连串大写里接小写的那个（`HTTPServer` 的 S）。 */
function isCamelCaseStart(target: string, targetIndex: number): boolean {
  if (!isUpperCaseLetter(target[targetIndex])) return false

  const previous = target[targetIndex - 1]
  return !isUpperCaseLetter(previous) || isLowerCaseLetter(target[targetIndex + 1])
}

/** `query[queryIndex]` 落在 `target[targetIndex]` 这一个字符得的分；`run` 是它前面已经连着命中的长度。 */
function scoreCharacter(
  query: string,
  target: string,
  queryIndex: number,
  targetIndex: number,
  run: number
): number {
  let score = 1
  if (query[queryIndex] === target[targetIndex]) score += 1
  if (run > 0) score += run * ConsecutiveBonus
  if (targetIndex === 0) return score + StartBonus

  const previous = target[targetIndex - 1]
  if (previous === '/' || previous === '\\') return score + PathSeparatorBonus
  if (WordSeparators.has(previous)) return score + WordSeparatorBonus
  if (run === 0 && isCamelCaseStart(target, targetIndex)) return score + CamelCaseBonus
  return score
}

/**
 * 给 `target` 按 `query` 打分；查询字符不能按顺序全在目标里时返回 null。空查询不算匹配。
 * 热路径上的调用方可以传入算好的小写形式。
 */
export function scoreWorkbenchFuzzy(
  target: string,
  query: string,
  lowercase?: WorkbenchFuzzyLowercase
): Nullable<WorkbenchFuzzyMatch> {
  const queryLength = query.length
  const targetLength = target.length
  if (queryLength === 0 || queryLength > targetLength) return null

  const targetLower = lowercase?.target ?? target.toLowerCase()
  const queryLower = lowercase?.query ?? query.toLowerCase()
  if (!isWorkbenchFuzzySubsequence(targetLower, queryLower)) return null

  // 同一格的最高分可能只有较短的连续后缀，不能丢掉以后靠连续奖励胜出的候选。
  // 每条匹配对角线用上凸包保留这些run；每个候选只入栈、出栈一次，仍为O(m*n)。
  ensureMatrixCapacity(queryLength * targetLength, targetLength)
  const diagonalCount = targetLength - queryLength + 1
  diagonalScores.fill(0, 0, diagonalCount)
  diagonalTails.fill(-1, 0, diagonalCount)
  let previousRow = 0
  let currentRow = targetLength

  for (let queryIndex = 0; queryIndex < queryLength; queryIndex += 1) {
    const row = queryIndex * targetLength
    const queryCode = queryLower.charCodeAt(queryIndex)
    const lastTargetIndex = targetLength - queryLength + queryIndex
    let bestScore = NoScore
    let bestEnd = -1

    for (let targetIndex = queryIndex; targetIndex <= lastTargetIndex; targetIndex += 1) {
      const cell = row + targetIndex
      const diagonal = targetIndex - queryIndex
      let matchScore = NoScore
      if (targetLower.charCodeAt(targetIndex) === queryCode) {
        // base不含连续奖励或camel起点奖励；后者只属于新run的首字符。
        const base = scoreCharacter(query, target, queryIndex, targetIndex, 1) - ConsecutiveBonus
        const prefixScore =
          queryIndex === 0
            ? 0
            : targetIndex > queryIndex
              ? rowScores[previousRow + targetIndex - 2]
              : NoScore
        let tail = diagonalTails[diagonal]

        if (prefixScore > NoScore) {
          // run从s开始、在i结束时，连续奖励为5*(i-s+1)*(i-s)/2。
          // 去掉公共的base前缀和+5*i*(i+1)/2后，候选是B_s-5*s*i。
          // B_s收进gap前缀、run首字符camel奖励及起点常数，矩阵格标识起点s。
          const intercept =
            prefixScore +
            scoreCharacter(query, target, queryIndex, targetIndex, 0) - base -
            diagonalScores[diagonal] +
            ConsecutiveBonus * queryIndex * (queryIndex - 1) / 2
          runIntercepts[cell] = intercept
          runPrefixEnds[cell] =
            queryIndex === 0 ? -1 : rowEnds[previousRow + targetIndex - 2]

          // s递增，斜率递减。删掉不可能单独胜出的中间线，不丢仍有未来优势的run。
          while (tail >= 0 && hullPrevious[tail] >= 0) {
            const before = hullPrevious[tail]
            const beforeStart = Math.floor(before / targetLength)
            const tailStart = Math.floor(tail / targetLength)
            if (
              (intercept - runIntercepts[tail]) * (tailStart - beforeStart) <
              (runIntercepts[tail] - runIntercepts[before]) * (queryIndex - tailStart)
            )
              break
            tail = before
          }
          hullPrevious[cell] = tail
          tail = cell
        }

        diagonalScores[diagonal] += base
        // i单调递增；旧线斜率更大，一旦不差于尾线，尾线以后也不会再胜出。
        while (tail >= 0 && hullPrevious[tail] >= 0) {
          const before = hullPrevious[tail]
          const beforeScore =
            runIntercepts[before] -
            ConsecutiveBonus * queryIndex * Math.floor(before / targetLength)
          const tailScore =
            runIntercepts[tail] -
            ConsecutiveBonus * queryIndex * Math.floor(tail / targetLength)
          if (beforeScore < tailScore) break
          tail = before
        }
        diagonalTails[diagonal] = tail
        if (tail >= 0) {
          matchedRunStarts[cell] = tail
          matchScore =
            diagonalScores[diagonal] +
            ConsecutiveBonus * queryIndex * (queryIndex + 1) / 2 +
            runIntercepts[tail] -
            ConsecutiveBonus * queryIndex * Math.floor(tail / targetLength)
        }
      } else {
        // 字符不匹配便断开连续段，不能让旧run穿过这个位置。
        diagonalScores[diagonal] = 0
        diagonalTails[diagonal] = -1
      }

      // 同分保留更早的结束位置；同结束位置的run同分优先延长，沿用原有规则。
      if (matchScore > bestScore) {
        bestScore = matchScore
        bestEnd = cell
      }
      rowScores[currentRow + targetIndex] = bestScore
      rowEnds[currentRow + targetIndex] = bestEnd
    }

    const completedRow = currentRow
    currentRow = previousRow
    previousRow = completedRow
  }

  const score = rowScores[previousRow + targetLength - 1]
  if (score <= NoScore) return null

  // 每个候选保存run前的最优前缀末端；按整段run回溯，不重新扫描矩阵。
  const positions = Array.from<number>({ length: queryLength })
  let end = rowEnds[previousRow + targetLength - 1]
  while (end >= 0) {
    const start = matchedRunStarts[end]
    const firstQueryIndex = Math.floor(start / targetLength)
    const lastQueryIndex = Math.floor(end / targetLength)
    const lastTargetIndex = end % targetLength
    for (let queryIndex = lastQueryIndex; queryIndex >= firstQueryIndex; queryIndex -= 1) {
      positions[queryIndex] = lastTargetIndex - lastQueryIndex + queryIndex
    }
    end = runPrefixEnds[start]
  }

  return { score, positions }
}
