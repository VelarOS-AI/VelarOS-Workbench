import { type WorkbenchLanguageServiceHoverDocumentationBlock } from '@shared/contracts/workbench'

/**
 * 语言服务器悬浮说明里的 Markdown（Pyright、Markdown 语言服务、外部 LSP）拆成编辑器能画的块：代码块、段落。
 * 只认悬浮说明里实际会出现的写法——围栏代码、分隔线、标题、列表、行尾硬换行、行内代码、强调、链接、转义、
 * HTML 实体；不是完整的 CommonMark。段落里的硬换行保留为 `\n`，行内代码保留成单个反引号包住的形式。
 */

type HoverMarkdownBlock = WorkbenchLanguageServiceHoverDocumentationBlock

const FencePattern = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/u
const RulePattern = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u
const HeadingPattern = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u
const ListItemPattern = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/u
const HardBreakPattern = /(?: {2,}|\\)$/u
const CodeSpanPattern = /(`+)([\s\S]*?[^`])\1(?!`)/gu
const EscapablePunctuation = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu

const NamedEntities: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/giu, (entity, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity
    }
    return NamedEntities[body.toLowerCase()] ?? entity
  })
}

/** 行内代码以外的 Markdown 标记去掉，只留文字。 */
function plainInlineText(text: string): string {
  return decodeHtmlEntities(
    text
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/gu, '$1')
      .replace(/(?<!\\)\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/gu, '$1')
      .replace(/<((?:https?|file|mailto):[^>\s]+)>/giu, '$1')
      .replace(/(?<!\\)(\*\*|__)(?=\S)([\s\S]*?\S)(?<!\\)\1/gu, '$2')
      .replace(/(?<![\\\w*])\*(?=[^\s*])([^*]*?[^\s\\*])\*(?![\w*])/gu, '$1')
      .replace(/(?<![\\\w])_(?=[^\s_])([^_]*?[^\s\\_])_(?!\w)/gu, '$1')
      .replace(EscapablePunctuation, '$1')
  )
}

/** 段落文字：行内代码原样留成 `code`，其余去掉标记。 */
function renderInline(text: string): string {
  let output = ''
  let cursor = 0
  for (const match of text.matchAll(CodeSpanPattern)) {
    const start = match.index ?? 0
    // 反斜杠转义的反引号不开代码段。
    if (start > 0 && text[start - 1] === '\\') continue
    output += plainInlineText(text.slice(cursor, start))
    const code = (match[2] ?? '').replace(/\n/gu, ' ').trim()
    output += code.includes('`') ? code : `\`${code}\``
    cursor = start + match[0].length
  }
  return output + plainInlineText(text.slice(cursor))
}

function joinParagraphLines(lines: readonly string[]): string {
  let text = ''
  lines.forEach((line, index) => {
    const content = line.replace(HardBreakPattern, '').trim()
    if (index > 0) {
      const hardBreak = HardBreakPattern.test(lines[index - 1]!) || ListItemPattern.test(line)
      text += hardBreak ? '\n' : ' '
    }
    text += ListItemPattern.test(line) ? content.replace(ListItemPattern, '• ') : content
  })
  return renderInline(text)
}

/** 整段只是一个行内代码（外部 LSP 常用 ``签名`` 当标题）时返回其中的代码。 */
export function hoverParagraphCode(line: string): Nullable<string> {
  const match = /^(`+)([\s\S]*?[^`])\1$/u.exec(line.trim())
  return match ? (match[2] ?? '').trim() : null
}

export function parseLanguageServiceHoverMarkdown(value: string): HoverMarkdownBlock[] {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: HoverMarkdownBlock[] = []
  let paragraph: string[] = []
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const text = joinParagraphLines(paragraph).trim()
    if (text) blocks.push({ kind: 'paragraph', text })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fence = FencePattern.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[1]!
      const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`, 'u')
      const body: string[] = []
      for (index += 1; index < lines.length && !closing.test(lines[index]!); index += 1)
        body.push(lines[index]!)
      const text = body.join('\n').replace(/^\n+|\s+$/gu, '')
      if (text) blocks.push({ kind: 'code', text, language: fence[2] || undefined })
      continue
    }
    // 分隔线只是视觉分节（Pyright 用它隔开签名与说明），编辑器自己会画分隔。
    if (RulePattern.test(line) || !line.trim()) {
      flushParagraph()
      continue
    }
    const heading = HeadingPattern.exec(line)
    if (heading) {
      flushParagraph()
      paragraph = [heading[1] ?? '']
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks
}

/** 块的纯文字版本（行内代码去掉反引号），给只认一段文字的地方用。 */
export function hoverBlockPlainText(block: HoverMarkdownBlock): string {
  return block.kind === 'code' ? block.text : block.text.replace(/`([^`\n]+)`/gu, '$1')
}
