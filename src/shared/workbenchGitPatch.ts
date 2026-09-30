/**
 * git 统一 diff 里一个文件的补丁：文件头，加上一块块改动（hunk）。编辑区按拆出来的块画差异、在块上放按钮；
 * 主进程按块暂存、取消暂存、回滚时，从 git 自己的输出里挑出同样的块重新拼成补丁交给 `git apply`。
 */

export interface WorkbenchGitPatchHunk {
  /** `@@ -a,b +c,d @@ …` 这一行，原样。 */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** 块里的各行，原样：带 ` `、`-`、`+`、`\` 前缀，CRLF 文件的行尾还留着 `\r`。 */
  lines: string[]
}

export interface WorkbenchGitFilePatch {
  /** `diff --git` 那一行到第一个 `@@` 之前的各行。 */
  headerLines: string[]
  hunks: WorkbenchGitPatchHunk[]
  /** 输出被截断，最后一块不完整。 */
  incomplete: boolean
}

/** 按块操作要把块原样认出来：块头和每一行都一样才算同一块。 */
export interface WorkbenchGitHunkSelector {
  header: string
  lines: string[]
}

const HunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/** 拆出统一 diff 里的每个文件；块按块头里的行数读，读不满（输出被截断）的记为不完整。 */
export function parseWorkbenchGitFilePatches(diff: string): WorkbenchGitFilePatch[] {
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const patches: WorkbenchGitFilePatch[] = []
  let current: Nullable<WorkbenchGitFilePatch> = null
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith('diff --git ')) {
      current = { headerLines: [line], hunks: [], incomplete: false }
      patches.push(current)
      index += 1
      continue
    }
    const header = HunkHeaderPattern.exec(line)
    if (!current || !header) {
      // 文件头里的行（index、---、+++、rename from…）；第一个 `diff --git` 之前的不算。
      if (current && current.hunks.length === 0) current.headerLines.push(line)
      index += 1
      continue
    }

    const hunk: WorkbenchGitPatchHunk = {
      header: line,
      oldStart: Number(header[1]),
      oldLines: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newLines: header[4] === undefined ? 1 : Number(header[4]),
      lines: [],
    }
    let oldRemaining = hunk.oldLines
    let newRemaining = hunk.newLines
    index += 1
    while (index < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
      const body = lines[index]
      const marker = body[0]
      if (marker === ' ' || marker === undefined) {
        oldRemaining -= 1
        newRemaining -= 1
      } else if (marker === '-') {
        oldRemaining -= 1
      } else if (marker === '+') {
        newRemaining -= 1
      } else if (marker !== '\\') {
        break
      }
      hunk.lines.push(marker === undefined ? ' ' : body)
      index += 1
    }
    // 最后一行没有换行符时，git 在它后面补一行 `\ No newline at end of file`。
    while (index < lines.length && lines[index].startsWith('\\')) {
      hunk.lines.push(lines[index])
      index += 1
    }
    if (oldRemaining > 0 || newRemaining > 0) current.incomplete = true
    current.hunks.push(hunk)
  }
  return patches
}

/**
 * 只能整个文件一起暂存、回滚的补丁：新建、删除、二进制，以及还有块没读完整的。改名、改权限的可以按块：
 * 按块时只动内容，改名和权限留给整个文件的操作。
 */
export function isWorkbenchGitWholeFilePatch(patch: WorkbenchGitFilePatch): boolean {
  return (
    patch.incomplete ||
    patch.hunks.length === 0 ||
    patch.headerLines.some(
      (line) =>
        line.startsWith('new file mode ') ||
        line.startsWith('deleted file mode ') ||
        line.startsWith('Binary files ') ||
        line === 'GIT binary patch'
    )
  )
}

export function isSameWorkbenchGitHunk(
  hunk: WorkbenchGitHunkSelector,
  selector: WorkbenchGitHunkSelector
): boolean {
  return (
    hunk.header === selector.header &&
    hunk.lines.length === selector.lines.length &&
    hunk.lines.every((line, index) => line === selector.lines[index])
  )
}

const QuotedPathEscapes: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\u0007': '\\a',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 0x20 || code === 0x7f
}

/** 补丁头里的路径：含引号、反斜杠、控制字符时按 git 的 C 风格加引号，别的（空格、中文）原样。 */
function quotePatchPath(path: string): string {
  const chars = [...path]
  if (!chars.some((char) => char === '"' || char === '\\' || isControlCharacter(char)))
    return path
  const body = chars
    .map((char) => {
      const escaped = QuotedPathEscapes[char]
      if (escaped) return escaped
      return isControlCharacter(char)
        ? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`
        : char
    })
    .join('')
  return `"${body}"`
}

/**
 * 只改一个文件内容的补丁，交给 `git apply`：`path` 相对仓库根，块照原样抄。不带改名、权限这些文件头：
 * 按块操作只动内容，改名和权限留给整个文件的暂存、回滚。
 */
export function buildWorkbenchGitHunkPatch(
  path: string,
  hunks: readonly WorkbenchGitPatchHunk[]
): string {
  const oldName = quotePatchPath(`a/${path}`)
  const newName = quotePatchPath(`b/${path}`)
  return [
    `diff --git ${oldName} ${newName}`,
    `--- ${oldName}`,
    `+++ ${newName}`,
    ...hunks.flatMap((hunk) => [hunk.header, ...hunk.lines]),
    '',
  ].join('\n')
}
