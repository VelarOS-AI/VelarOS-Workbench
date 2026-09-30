/**
 * `git blame --incremental` 的输出解析成「每一行属于哪个提交」。
 *
 * 输出是一块一块的：每块第一行是 `<40 位提交号> <原行号> <现行号> <行数>`，一个提交第一次出现时后面跟着它的
 * 信息（`author`、`author-time`、`summary` ……），以 `filename` 一行收尾；不带正文。还没提交的行挂在全零的
 * 提交号上。
 */

export interface WorkbenchGitBlameCommit {
  sha: string
  author: string
  /** 作者时间，Unix 秒。 */
  authorTime: number
  summary: string
}

export interface WorkbenchGitBlame {
  /** 出现过的提交。 */
  commits: WorkbenchGitBlameCommit[]
  /** `lines[i]` 是第 i + 1 行所属提交在 `commits` 里的下标；还没提交的行是 -1。 */
  lines: number[]
}

const UncommittedSha = '0'.repeat(40)
const BlockHeaderPattern = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/u

export function parseWorkbenchGitBlame(output: string): WorkbenchGitBlame {
  const commits: WorkbenchGitBlameCommit[] = []
  const indexBySha = new Map<string, number>()
  const lines: number[] = []
  let current: Nullable<WorkbenchGitBlameCommit> = null

  for (const row of output.split('\n')) {
    const header = BlockHeaderPattern.exec(row)
    if (header) {
      const sha = header[1]!
      let index = -1
      if (sha === UncommittedSha) {
        current = null
      } else {
        index = indexBySha.get(sha) ?? commits.length
        if (index === commits.length) {
          indexBySha.set(sha, index)
          commits.push({ sha, author: '', authorTime: 0, summary: '' })
        }
        current = commits[index]!
      }
      const first = Number(header[2]) - 1
      for (let offset = 0; offset < Number(header[3]); offset += 1) lines[first + offset] = index
      continue
    }
    if (!current) continue
    if (row.startsWith('author ')) current.author = row.slice('author '.length)
    else if (row.startsWith('author-time '))
      current.authorTime = Number(row.slice('author-time '.length))
    else if (row.startsWith('summary ')) current.summary = row.slice('summary '.length)
  }

  // 输出里没提到的行（不应该有）按还没提交算。
  for (let index = 0; index < lines.length; index += 1) lines[index] ??= -1
  return { commits, lines }
}
