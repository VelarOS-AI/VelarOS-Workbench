import { foldEffect, foldService } from '@codemirror/language'
import type { Extension, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface WorkbenchImportFoldRange {
  from: number
  to: number
}

interface SourceLineSkeleton {
  code: string
  /** 行尾仍未闭合的记号（块注释、三引号串、模板串），下一行从它开始找闭合。 */
  pending: Nullable<string>
}

/** 字符串整段换成的占位：只留下「这里有个字符串」，串里的括号和关键字一律不算数。 */
const StringPlaceholder = "''"
const BlockCommentClose = '*/'
/** 注释与字符串的起始记号。`#` 一律按行注释：Python 注释和 shebang 都走它，C 系语言的 import 区里它不会出现在串外。 */
const SkeletonToken = /\/\/|#|\/\*|"""|'''|["'`]/gu
/** 行首开启一条导入语句：`import …`（不含 `import(`、`import.meta`）或 Python 的 `from … import`。 */
const ImportStatementStart = /^(?:import(?![\w$.(])|from\s)/u
/** 语句明显还没写完：停在逗号、`=`、反斜杠续行，或停在 `from` / `import` 关键字上。 */
const DanglingStatementTail = /(?:[,=\\]|\b(?:from|import))$/u
const DirectiveStatement = /^(?:[rRuU]?''\s*;?\s*)+$/u
const PackageDeclaration = /^package\s+[\w.]+\s*;?$/u

const importFoldRanges = new WeakMap<Text, Nullable<WorkbenchImportFoldRange>>()

/** 从 from 起找 closer，返回闭合记号之后的下标，找不到为 -1；字符串里的反斜杠转义下一个字符。 */
function findClosingIndex(text: string, from: number, closer: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (text.startsWith(closer, index)) return index + closer.length
    if (closer !== BlockCommentClose && text[index] === '\\') index += 1
  }
  return -1
}

/** 把一行压成代码骨架：注释去掉、字符串换成占位；跨行的注释和字符串经 pending 接到下一行。 */
function skeletonOfLine(text: string, pending: Nullable<string>): SourceLineSkeleton {
  let code = ''
  let index = 0

  if (pending) {
    if (pending !== BlockCommentClose) code += StringPlaceholder
    const end = findClosingIndex(text, 0, pending)
    if (end < 0) return { code, pending }
    index = end
  }

  SkeletonToken.lastIndex = index
  let token = SkeletonToken.exec(text)
  while (token) {
    code += text.slice(index, token.index)
    const opener = token[0]
    if (opener === '//' || opener === '#') return { code, pending: null }

    const closer = opener === '/*' ? BlockCommentClose : opener
    if (closer !== BlockCommentClose) code += StringPlaceholder
    const end = findClosingIndex(text, SkeletonToken.lastIndex, closer)
    // 单引号、双引号串不跨行：没闭合就当它在行尾结束。
    if (end < 0) return { code, pending: opener === '"' || opener === "'" ? null : closer }

    index = end
    SkeletonToken.lastIndex = index
    token = SkeletonToken.exec(text)
  }

  return { code: code + text.slice(index), pending: null }
}

/** 首条 import 之前允许出现的非代码语句：指令（'use client'）、文档字符串、package 声明。 */
function isPreambleStatement(code: string): boolean {
  return DirectiveStatement.test(code) || PackageDeclaration.test(code)
}

function bracketBalance(code: string): number {
  let balance = 0
  for (const char of code) {
    if (char === '{' || char === '(' || char === '[') balance += 1
    else if (char === '}' || char === ')' || char === ']') balance -= 1
  }
  return balance
}

/**
 * 文件头的 import 区：跳过开头的空行、注释、指令和 package 声明，从首条 import 起到最后一条
 * 写完整的导入语句为止。多行 import 的续行、分组之间的空行和夹在中间的注释都算在区内。
 */
function scanImportFoldRange(doc: Text): Nullable<WorkbenchImportFoldRange> {
  let pending: Nullable<string> = null
  let firstLine = 0
  let lastLine = 0
  let depth = 0
  let statementOpen = false

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const skeleton = skeletonOfLine(doc.line(lineNumber).text, pending)
    pending = skeleton.pending
    const code = skeleton.code.trim()
    if (!code) continue

    if (!statementOpen) {
      if (!ImportStatementStart.test(code)) {
        if (!firstLine && isPreambleStatement(code)) continue
        break
      }
      if (!firstLine) firstLine = lineNumber
    }

    depth = Math.max(0, depth + bracketBalance(code))
    statementOpen = depth > 0 || DanglingStatementTail.test(code)
    // 只收写完整的语句：文件里还悬着的半条 import 不进折叠区，免得把后面的代码一起吞掉。
    if (!statementOpen) lastLine = lineNumber
  }

  if (lastLine <= firstLine) return null
  return { from: doc.line(firstLine).to, to: doc.line(lastLine).to }
}

/** import 区的折叠范围：保留首条 import 的首行，收起其后直到最后一条 import 的内容；按文档版本缓存。 */
export function findWorkbenchImportFoldRange(doc: Text): Nullable<WorkbenchImportFoldRange> {
  const cached = importFoldRanges.get(doc)
  if (cached !== undefined) return cached

  const range = scanImportFoldRange(doc)
  importFoldRanges.set(doc, range)
  return range
}

/** import 区在折叠栏上有自己的开合标记：展开后还能再收起，和打开文件时的自动折叠是同一个区间。 */
export const workbenchImportFoldExtension: Extension = foldService.of((state, _lineStart, lineEnd) => {
  const range = findWorkbenchImportFoldRange(state.doc)
  return range?.from === lineEnd ? range : null
})

/** 打开文件时收起 import 区。 */
export function foldWorkbenchImportBlock(view: EditorView): void {
  const range = findWorkbenchImportFoldRange(view.state.doc)
  if (range) view.dispatch({ effects: foldEffect.of(range) })
}
