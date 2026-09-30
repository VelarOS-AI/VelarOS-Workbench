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
let matchScores = new Int32Array(0)
let bestScores = new Int32Array(0)
let runLengths = new Int32Array(0)
let extendsRun = new Uint8Array(0)

function ensureMatrixCapacity(size: number): void {
  if (matchScores.length >= size) return

  const capacity = Math.max(size, matchScores.length * 2, 256)
  matchScores = new Int32Array(capacity)
  bestScores = new Int32Array(capacity)
  runLengths = new Int32Array(capacity)
  extendsRun = new Uint8Array(capacity)
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

/** 第 `queryIndex` 个查询字符在 `target[0..limit]` 里取得最高分的最靠前位置。 */
function findBestPosition(
  queryIndex: number,
  limit: number,
  targetLength: number
): number {
  const row = queryIndex * targetLength
  const best = bestScores[row + limit]
  for (let targetIndex = queryIndex; targetIndex <= limit; targetIndex += 1) {
    if (matchScores[row + targetIndex] === best) return targetIndex
  }
  return limit
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

  // matchScores[i][j]：第 i 个查询字符恰好落在 target[j] 时，前 i+1 个字符的最高总分；
  // bestScores[i][j]：第 i 个查询字符落在 target[0..j] 里任意一处时的最高总分。
  const size = queryLength * targetLength
  ensureMatrixCapacity(size)
  matchScores.fill(NoScore, 0, size)
  bestScores.fill(NoScore, 0, size)

  for (let queryIndex = 0; queryIndex < queryLength; queryIndex += 1) {
    const row = queryIndex * targetLength
    const previousRow = row - targetLength
    const queryCode = queryLower.charCodeAt(queryIndex)
    // 后面还有 queryLength - queryIndex - 1 个字符要放，这一个最多只能放到这里。
    const lastTargetIndex = targetLength - queryLength + queryIndex

    for (let targetIndex = queryIndex; targetIndex <= lastTargetIndex; targetIndex += 1) {
      const cell = row + targetIndex
      if (targetLower.charCodeAt(targetIndex) === queryCode) {
        if (queryIndex === 0) {
          matchScores[cell] = scoreCharacter(query, target, 0, targetIndex, 0)
          runLengths[cell] = 1
          extendsRun[cell] = 0
        } else {
          // 接着上一个字符连着命中，或者与它隔开（它落在 targetIndex - 2 及以前）。
          const extended = matchScores[previousRow + targetIndex - 1]
          const separated = targetIndex >= 2 ? bestScores[previousRow + targetIndex - 2] : NoScore
          const extendedScore =
            extended > NoScore
              ? extended +
                scoreCharacter(query, target, queryIndex, targetIndex, runLengths[previousRow + targetIndex - 1])
              : NoScore
          const separatedScore =
            separated > NoScore
              ? separated + scoreCharacter(query, target, queryIndex, targetIndex, 0)
              : NoScore

          if (extendedScore > NoScore && extendedScore >= separatedScore) {
            matchScores[cell] = extendedScore
            runLengths[cell] = runLengths[previousRow + targetIndex - 1] + 1
            extendsRun[cell] = 1
          } else if (separatedScore > NoScore) {
            matchScores[cell] = separatedScore
            runLengths[cell] = 1
            extendsRun[cell] = 0
          }
        }
      }

      const left = targetIndex > queryIndex ? bestScores[cell - 1] : NoScore
      bestScores[cell] = Math.max(left, matchScores[cell])
    }
  }

  const lastRow = (queryLength - 1) * targetLength
  const lastTargetIndex = targetLength - 1
  const score = bestScores[lastRow + lastTargetIndex]
  if (score <= NoScore) return null

  // 从最后一个查询字符往回找命中位置：连着命中的接上一格，隔开的在它前面两格以内取最高分的最靠前一处。
  const positions = Array.from<number>({ length: queryLength })
  let targetIndex = findBestPosition(queryLength - 1, lastTargetIndex, targetLength)
  for (let queryIndex = queryLength - 1; queryIndex >= 0; queryIndex -= 1) {
    positions[queryIndex] = targetIndex
    if (queryIndex === 0) break

    targetIndex = extendsRun[queryIndex * targetLength + targetIndex]
      ? targetIndex - 1
      : findBestPosition(queryIndex - 1, targetIndex - 2, targetLength)
  }

  return { score, positions }
}
