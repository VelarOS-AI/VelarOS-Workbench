/**
 * LSP / TypeScript 片段（`$1`、`${2:默认}`、`${3|a,b|}`、`$0`、`$TM_…` 变量）换成 CodeMirror `snippet()` 的模板。
 *
 * CodeMirror 的模板只认 `${n}` / `${n:默认}`（默认值里不能有花括号、不能换行），字面的 `{` `}` 要写成 `\{` `\}`；
 * 嵌套占位符摊平成外层的默认文字，选项取第一项，变量取默认值（没有就空）。
 */

type SnippetNode =
  | { kind: 'text'; value: string }
  | { kind: 'field'; index: number; children: SnippetNode[]; choice?: string }
  | { kind: 'variable'; children: SnippetNode[] }

export interface WorkbenchConvertedSnippet {
  /** 交给 `snippet()` 的模板。 */
  template: string
  /** 占位符换成默认文字后的纯文本（不需要跳转时直接插入它）。 */
  text: string
  /** 有 `$0` 以外的占位符：接受后要能按 Tab 在占位符间跳。 */
  hasFields: boolean
  /** 有任何占位符（含 `$0`）：光标要落到占位符上，而不是插入文字的末尾。 */
  hasTabStops: boolean
}

class LspSnippetParser {
  private index = 0

  public constructor(private readonly source: string) {}

  public parse(): SnippetNode[] {
    return this.parseNodes(null)
  }

  /** 读到 `terminator`（`}`）或结尾为止。 */
  private parseNodes(terminator: Nullable<string>): SnippetNode[] {
    const nodes: SnippetNode[] = []
    let text = ''
    const flush = (): void => {
      if (text) nodes.push({ kind: 'text', value: text })
      text = ''
    }
    while (this.index < this.source.length) {
      const character = this.source[this.index]!
      if (terminator && character === terminator) break
      if (character === '\\') {
        const next = this.source[this.index + 1]
        // 片段里只有 `$`、`}`、`\` 需要转义；别的反斜杠照原样留着。
        if (next === '$' || next === '}' || next === '\\') {
          text += next
          this.index += 2
          continue
        }
        text += character
        this.index += 1
        continue
      }
      if (character === '$') {
        const node = this.parseDollar()
        if (node) {
          flush()
          nodes.push(node)
          continue
        }
      }
      text += character
      this.index += 1
    }
    flush()
    return nodes
  }

  private parseDollar(): Nullable<SnippetNode> {
    const start = this.index
    const rest = this.source.slice(this.index + 1)
    const bareIndex = /^\d+/u.exec(rest)
    if (bareIndex) {
      this.index += 1 + bareIndex[0].length
      return { kind: 'field', index: Number(bareIndex[0]), children: [] }
    }
    const bareVariable = /^[A-Za-z_]\w*/u.exec(rest)
    if (bareVariable) {
      this.index += 1 + bareVariable[0].length
      return { kind: 'variable', children: [] }
    }
    if (rest[0] !== '{') return null

    this.index += 2
    const indexMatch = /^\d+/u.exec(this.source.slice(this.index))
    if (indexMatch) {
      const index = Number(indexMatch[0])
      this.index += indexMatch[0].length
      const marker = this.source[this.index]
      if (marker === '}') {
        this.index += 1
        return { kind: 'field', index, children: [] }
      }
      if (marker === ':') {
        this.index += 1
        const children = this.parseNodes('}')
        if (this.source[this.index] !== '}') return this.fail(start)
        this.index += 1
        return { kind: 'field', index, children }
      }
      if (marker === '|') {
        const end = this.source.indexOf('|}', this.index + 1)
        if (end === -1) return this.fail(start)
        const choices = this.source
          .slice(this.index + 1, end)
          .split(/(?<!\\),/u)
          .map((choice) => choice.replace(/\\([,|\\$}])/gu, '$1'))
        this.index = end + 2
        return { kind: 'field', index, children: [], choice: choices[0] ?? '' }
      }
      return this.fail(start)
    }

    const variable = /^[A-Za-z_]\w*/u.exec(this.source.slice(this.index))
    if (!variable) return this.fail(start)
    this.index += variable[0].length
    const marker = this.source[this.index]
    if (marker === '}') {
      this.index += 1
      return { kind: 'variable', children: [] }
    }
    if (marker === ':') {
      this.index += 1
      const children = this.parseNodes('}')
      if (this.source[this.index] !== '}') return this.fail(start)
      this.index += 1
      return { kind: 'variable', children }
    }
    // `${VAR/regex/format/options}`：编辑器没有这些变量的值，整段按空处理。
    if (marker === '/') {
      const end = this.source.indexOf('}', this.index)
      if (end === -1) return this.fail(start)
      this.index = end + 1
      return { kind: 'variable', children: [] }
    }
    return this.fail(start)
  }

  /** 不是合法的占位符：`$` 当字面字符。 */
  private fail(start: number): null {
    this.index = start
    return null
  }
}

function plainText(nodes: readonly SnippetNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return node.value
      if (node.kind === 'field') return node.choice ?? plainText(node.children)
      return plainText(node.children)
    })
    .join('')
}

function escapeTemplateText(text: string): string {
  return text.replace(/[{}]/gu, (brace) => `\\${brace}`)
}

/** 占位符的默认文字：不能有花括号，也不能跨行。 */
function templateDefault(text: string): string {
  return text.replace(/[{}]/gu, '').replace(/\r?\n/gu, ' ')
}

export function convertWorkbenchLspSnippet(snippet: string): WorkbenchConvertedSnippet {
  const nodes = new LspSnippetParser(snippet).parse()
  const defaults = new Map<number, string>()
  const collectDefaults = (items: readonly SnippetNode[]): void => {
    for (const node of items) {
      if (node.kind !== 'field') continue
      const value = node.choice ?? plainText(node.children)
      if (value && !defaults.get(node.index)) defaults.set(node.index, value)
      if (!defaults.has(node.index)) defaults.set(node.index, '')
    }
  }
  collectDefaults(nodes)

  let hasFields = false
  const template = nodes
    .map((node) => {
      if (node.kind === 'text') return escapeTemplateText(node.value)
      if (node.kind === 'variable') return escapeTemplateText(plainText(node.children))
      if (node.index > 0) hasFields = true
      const value = templateDefault(defaults.get(node.index) ?? '')
      return value ? `\${${node.index}:${value}}` : `\${${node.index}}`
    })
    .join('')
  const text = nodes
    .map((node) => (node.kind === 'field' ? (defaults.get(node.index) ?? '') : plainText([node])))
    .join('')

  return {
    template,
    text,
    hasFields,
    hasTabStops: defaults.size > 0,
  }
}
