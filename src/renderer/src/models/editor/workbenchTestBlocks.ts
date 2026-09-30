/**
 * 测试文件里的 `describe` / `it` / `test`：从编辑器已有的语法树里找，纯语法，不执行任何代码。
 *
 * 只看给定的范围（可见区）：语法树按需解析，范围之外的不去碰。外层的 `describe` 即使开头在范围之上也会被
 * 遍历到（它的节点盖着这个范围），所以每个块都拿得到完整的外层名字。
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

export interface WorkbenchTestBlock {
  kind: 'suite' | 'test'
  /** 源码里写的标题；不是字面量的部分原样留着（`${name}`、`Foo.name`）。 */
  title: string
  /**
   * 交给运行器 `-t` 的正则：连同外层 `describe` 的全名。测试收尾加 `$`（只跑这一个）；`describe` 只匹配开头
   * （跑它里面的全部）。
   */
  pattern: string
  /** 这个调用在文档里的范围。 */
  from: number
  to: number
}

const SuiteFunctions = new Set(['describe', 'suite', 'fdescribe', 'xdescribe'])
const TestFunctions = new Set(['it', 'test', 'fit', 'xit', 'xtest'])
/** `it.each(表)(标题)`、`test.for(表)(标题)`：标题里的 `%s`、`$name` 每一行都不一样。 */
const ParameterizedModifiers = new Set(['each', 'for'])
/**
 * `it.only(…)`、`describe.skip(…)` 这类写法里点号后面能出现的名字。别的（`test.extend({…})`、
 * `test.step(…)`）不是在声明一个测试，不标。
 */
const TestModifiers = new Set([
  ...ParameterizedModifiers,
  'only',
  'skip',
  'todo',
  'concurrent',
  'sequential',
  'shuffle',
  'skipIf',
  'runIf',
  'fails',
  'failing',
])
/**
 * 全名里两级之间的分隔：Jest 和老版本 Vitest 是一个空格，新版本 Vitest 是 ` > `。两种都认，同一条正则两个
 * 运行器都能用。
 */
const NameSeparatorPattern = ' (?:> )?'
const AnyTextPattern = '.*'
const TitlePreviewMaxLength = 80

interface TestCallee {
  kind: WorkbenchTestBlock['kind']
  parameterized: boolean
}

interface TestTitle {
  text: string
  pattern: string
}

function escapePatternText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 字符串字面量里的转义还原成它代表的字符；认不出的转义去掉反斜杠。 */
function unescapeLiteral(raw: string): string {
  return raw.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/gu,
    (_match, codePoint: string, unicode: string, hex: string, character: string) => {
      const code = codePoint ?? unicode ?? hex
      if (code) return String.fromCodePoint(Number.parseInt(code, 16))
      switch (character) {
        case 'n':
          return '\n'
        case 'r':
          return '\r'
        case 't':
          return '\t'
        case 'b':
          return '\b'
        case 'f':
          return '\f'
        case 'v':
          return '\v'
        case '0':
          return '\0'
        // 反斜杠加换行是续行，不产生字符。
        case '\n':
        case '\r\n':
          return ''
        default:
          return character
      }
    }
  )
}

/**
 * 一段字面文字变成正则。带参数表的测试（`each` / `for`）标题里的占位——`%s` 这类 printf 记号、`$name` /
 * `$a.b` / `$#`——每行数据填的都不一样，换成「任意文字」。
 */
function literalToPattern(text: string, parameterized: boolean): string {
  if (!parameterized) return escapePatternText(text)

  return text
    .split(/(%[psdifjo#$%]|\$[A-Za-z_#][\w.]*)/u)
    .map((piece, index) => {
      if (index % 2 === 0) return escapePatternText(piece)
      return piece === '%%' ? '%' : AnyTextPattern
    })
    .join('')
}

/** 调用的是不是 `describe` / `it` / `test`（含 `.only`、`.skip`、`.each(表)`、`.skipIf(条件)` 这些写法）。 */
function readTestCallee(state: EditorState, call: SyntaxNode): Nullable<TestCallee> {
  let parameterized = false
  let current = call.firstChild
  while (current) {
    if (current.name === 'VariableName') {
      const name = state.sliceDoc(current.from, current.to)
      if (SuiteFunctions.has(name)) return { kind: 'suite', parameterized }
      if (TestFunctions.has(name)) return { kind: 'test', parameterized }
      return null
    }
    // 往里走一层：`it.only` 里面是 `it`；`it.each(表)`、`` it.each`表` `` 里面是 `it.each`。别的写法不是测试。
    switch (current.name) {
      case 'MemberExpression': {
        const property = current.lastChild
        const modifier =
          property?.name === 'PropertyName' ? state.sliceDoc(property.from, property.to) : ''
        if (!TestModifiers.has(modifier)) return null
        if (ParameterizedModifiers.has(modifier)) parameterized = true
        break
      }
      case 'CallExpression':
      case 'TaggedTemplateExpression':
        break
      default:
        return null
    }
    current = current.firstChild
  }
  return null
}

/** 第一个参数当标题：字符串和模板字符串读字面量，其它写法（变量、`Foo.name`）当成任意文字。 */
function readTestTitle(
  state: EditorState,
  call: SyntaxNode,
  parameterized: boolean
): Nullable<TestTitle> {
  const argument = call.getChild('ArgList')?.firstChild?.nextSibling
  if (!argument || argument.name === ')') return null

  const source = state.sliceDoc(argument.from, argument.to)
  if (argument.name === 'String') {
    const text = unescapeLiteral(source.slice(1, -1))
    return { text, pattern: literalToPattern(text, parameterized) }
  }
  if (argument.name === 'TemplateString') {
    // 字面的几段照字面匹配，`${…}` 插进来的当成任意文字。
    let pattern = ''
    let position = argument.from + 1
    for (const interpolation of argument.getChildren('Interpolation')) {
      pattern += literalToPattern(
        unescapeLiteral(state.sliceDoc(position, interpolation.from)),
        parameterized
      )
      pattern += AnyTextPattern
      position = interpolation.to
    }
    pattern += literalToPattern(
      unescapeLiteral(state.sliceDoc(position, argument.to - 1)),
      parameterized
    )
    return { text: source.slice(1, -1), pattern }
  }
  return { text: source, pattern: AnyTextPattern }
}

function previewTitle(text: string): string {
  const singleLine = text.replace(/\s+/gu, ' ').trim()
  return singleLine.length > TitlePreviewMaxLength
    ? `${singleLine.slice(0, TitlePreviewMaxLength - 1)}…`
    : singleLine
}

/**
 * `[from, to]` 这段文档里的测试块，按出现的顺序。语法树还没解析到这里（刚打开文件、先用的是基础着色）时
 * 是空的，解析到了再调一次就有。
 */
export function collectWorkbenchTestBlocks(
  state: EditorState,
  from: number,
  to: number
): WorkbenchTestBlock[] {
  const blocks: WorkbenchTestBlock[] = []
  /** 正在里面的各层 `describe`：它的范围与标题的正则。 */
  const openSuites: Array<{ from: number; to: number; pattern: string }> = []

  syntaxTree(state).iterate({
    from,
    to,
    enter(reference) {
      if (reference.name !== 'CallExpression') return

      const call = reference.node
      // `it.each(表)('标题', …)` 是两层调用：标题在外层，里层那个 `it.each(表)` 不是一个测试。
      const parent = call.parent
      if (parent?.name === 'CallExpression' && parent.firstChild?.from === call.from) return

      const callee = readTestCallee(state, call)
      if (!callee) return
      const title = readTestTitle(state, call, callee.parameterized)
      if (!title) return

      const names = [...openSuites.map((suite) => suite.pattern), title.pattern]
      blocks.push({
        kind: callee.kind,
        title: previewTitle(title.text),
        pattern:
          callee.kind === 'test'
            ? `^${names.join(NameSeparatorPattern)}$`
            : // 后面跟一个空格：名字只是以它开头的另一个 describe（`math` 与 `mathematics`）不算进来。
              `^${names.join(NameSeparatorPattern)} `,
        from: call.from,
        to: call.to,
      })
      if (callee.kind === 'suite')
        openSuites.push({ from: call.from, to: call.to, pattern: title.pattern })
    },
    leave(reference) {
      const innermost = openSuites.at(-1)
      if (
        reference.name === 'CallExpression' &&
        innermost?.from === reference.from &&
        innermost.to === reference.to
      )
        openSuites.pop()
    },
  })

  return blocks
}

/** 光标所在的最里层测试块（光标在 `it(…)` 里就是它，否则是包着它的 `describe`）；不在任何块里返回 null。 */
export function findWorkbenchTestBlockAt(
  state: EditorState,
  position: number
): Nullable<WorkbenchTestBlock> {
  // 块按出现的顺序排，包着光标的最后一个就是最里层的。
  return (
    collectWorkbenchTestBlocks(state, position, position).findLast(
      (block) => block.from <= position && position <= block.to
    ) ?? null
  )
}
