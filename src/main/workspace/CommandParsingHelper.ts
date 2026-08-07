import { isEmpty } from '@velaros-ai/core'

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = []
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

    if (isWhitespace(char)) {
      pushCurrent()
      continue
    }

    if (isOperatorStart(char)) {
      pushCurrent()
      const nextChar = command[index + 1] ?? ''
      // 处理 heredoc：先推入 `<<` 标记，再跳过正文内容。
      if (char === '<' && nextChar === '<') {
        tokens.push('<<')
        index += 1
        index += 1
        while (index < command.length && command[index] === ' ') index += 1
        let marker = ''
        while (index < command.length && command[index] !== '\n' && !isWhitespace(command[index])) {
          marker += command[index]
          index += 1
        }
        marker = marker.replace(/^['"]|['"]$/g, '')
        if (marker) {
          while (index < command.length) {
            while (index < command.length && command[index] !== '\n') index += 1
            if (index < command.length) index += 1
            let lineContent = ''
            while (index < command.length && command[index] !== '\n') {
              lineContent += command[index]
              index += 1
            }
            if (lineContent.trim() === marker) break
          }
        }
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
    char === '<'
  )
}

export { containsTokenSequence, tokenizeShellCommand }
