import { isEmpty } from '@velaros-ai/velaros/core'

/**
 * 把命令文本切成 token，给命令执行策略做词法判定用（不是完整的 shell 解析器）。
 *
 * 引号内容合成一个 token、去掉引号；操作符（`&&`、`|`、`;`、`&`、`(`、反引号、重定向）各自成 token。
 * 未加引号的换行和 `;` 一样分开两条命令，所以单独产出一个 `\n` token；反斜杠续行则被吞掉，
 * `git reset \` + 换行 + `--hard` 仍是同一条命令。heredoc 正文不是命令，整段跳过，但 `<<EOF` 所在行的
 * 其余部分照常切分（`cat <<EOF && git checkout -- .` 里的 git 不能被正文一起吞掉）。
 */
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = []
  const pendingHeredocMarkers: string[] = []
  let current = ''
  let quote: Nullable<'"' | "'"> = null
  let escaping = false

  const pushCurrent = (): void => {
    if (!current) return

    tokens.push(current)
    current = ''
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }

      if (quote === '"' && char === '\\') {
        const nextChar = command[index + 1] ?? ''
        // 双引号里的 Windows 路径分隔符必须保留；只把真正的 shell 转义序列吞掉。
        if (nextChar === '"' || nextChar === '\\' || nextChar === '$' || nextChar === '`') {
          escaping = true
        } else {
          current += char
        }
        continue
      }

      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '\\') {
      const nextChar = command[index + 1] ?? ''
      // 续行：反斜杠加换行（含 CRLF）什么也不是，前后仍是同一条命令。
      if (nextChar === '\n' || (nextChar === '\r' && command[index + 2] === '\n')) {
        index += nextChar === '\n' ? 1 : 2
        continue
      }
      // POSIX 用反斜杠转义空白/操作符；C:\\Users 这类 Windows 路径则保留分隔符。
      if (
        nextChar &&
        (isWhitespace(nextChar) ||
          isOperatorStart(nextChar) ||
          nextChar === '"' ||
          nextChar === "'" ||
          nextChar === '\\')
      ) {
        escaping = true
      } else {
        current += char
      }
      continue
    }

    if (char === '\n') {
      pushCurrent()
      if (tokens.at(-1) !== '\n') tokens.push('\n')
      for (const marker of pendingHeredocMarkers.splice(0)) {
        index = skipHeredocBody(command, index, marker)
      }
      continue
    }

    if (isWhitespace(char)) {
      pushCurrent()
      continue
    }

    if (isOperatorStart(char)) {
      pushCurrent()
      const nextChar = command[index + 1] ?? ''
      if (char === '<' && nextChar === '<') {
        // here-string（`<<<`）后面跟的是普通实参，照常切分。
        if (command[index + 2] === '<') {
          tokens.push('<<<')
          index += 2
          continue
        }
        // heredoc：记下结束标记，正文从下一个换行开始跳过（`<<-` 允许结束标记前有制表符）。
        tokens.push('<<')
        index += command[index + 2] === '-' ? 2 : 1
        const marker = readHeredocMarker(command, index + 1)
        index = marker.end - 1
        if (marker.value) pendingHeredocMarkers.push(marker.value)
        continue
      }
      if ((char === '&' || char === '|' || char === '>') && nextChar === char) {
        tokens.push(`${char}${char}`)
        index += 1
        continue
      }

      tokens.push(char)
      continue
    }

    current += char
  }

  pushCurrent()
  return tokens
}

/** 读 heredoc 的结束标记（`EOF`、`'EOF'`、`"EOF"`、`\EOF` 都是 EOF）；`end` 是标记之后的位置。 */
function readHeredocMarker(command: string, start: number): { value: string; end: number } {
  let index = start
  while (command[index] === ' ' || command[index] === '\t') index += 1
  let raw = ''
  while (
    index < command.length &&
    !isWhitespace(command[index]) &&
    !isOperatorStart(command[index])
  ) {
    raw += command[index]
    index += 1
  }
  return { value: raw.replace(/["'\\]/gu, ''), end: index }
}

/** 从 `newlineIndex` 处的换行之后跳过 heredoc 正文，返回结束标记那一行末尾的位置。 */
function skipHeredocBody(command: string, newlineIndex: number, marker: string): number {
  let lineStart = newlineIndex + 1
  while (lineStart < command.length) {
    const lineBreak = command.indexOf('\n', lineStart)
    const lineEnd = lineBreak < 0 ? command.length : lineBreak
    if (command.slice(lineStart, lineEnd).trim() === marker) return lineEnd
    lineStart = lineEnd + 1
  }
  return command.length
}

function containsTokenSequence(tokens: string[], sequence: string[]): boolean {
  if (isEmpty(sequence) || sequence.length > tokens.length) return false

  const normalizedTokens = tokens.map((token) => token.toLowerCase())
  const normalizedSequence = sequence.map((token) => token.toLowerCase())

  for (let index = 0; index <= normalizedTokens.length - normalizedSequence.length; index += 1) {
    let matched = true

    for (let offset = 0; offset < normalizedSequence.length; offset += 1) {
      if (normalizedTokens[index + offset] !== normalizedSequence[offset]) {
        matched = false
        break
      }
    }

    if (matched) return true
  }

  return false
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

function isOperatorStart(char: string): boolean {
  return (
    char === '&' ||
    char === '|' ||
    char === ';' ||
    char === '(' ||
    char === ')' ||
    char === '>' ||
    char === '<' ||
    char === '`'
  )
}

export { containsTokenSequence, tokenizeShellCommand }
