import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import type { WorkbenchLanguageServiceTextEdit } from '@shared/contracts'

/**
 * 文档格式化：**项目 Prettier 优先，内置规则回退**。
 *
 * - 若目标项目自带 `prettier`（`<projectRoot>/node_modules/prettier`），就用它 + 项目配置
 *   （`.prettierrc`/`.editorconfig`）格式化，完全遵循项目规范。
 * - 项目没有 Prettier 时回到编辑器内置规则：JSON 按记号重排（{@link formatWorkbenchJson}），其它做去行尾
 *   空白 + 结尾补换行（TS 家族的内置格式化在 {@link LanguageServices.getFormat} 里另走 TS 语言服务）。
 */

interface PrettierModuleLike {
  resolveConfig(
    filepath: string,
    options?: { editorconfig?: boolean }
  ): Promise<Record<string, unknown> | null>
  format(source: string, options?: Record<string, unknown>): Promise<string> | string
  getFileInfo(
    filepath: string,
    options?: Record<string, unknown>
  ): Promise<{ ignored: boolean; inferredParser: string | null }>
}

/** 每个 package 边界缓存一次 Prettier 解析结果（命中或未命中都缓存，避免重复探测）。 */
const projectPrettierCache = new Map<string, Nullable<PrettierModuleLike>>()

function isPathInside(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath)
  return (
    childRelativePath === '' ||
    (childRelativePath !== '..' &&
      !childRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(childRelativePath))
  )
}

function findNearestPackageJsonPath(projectRoot: string, absolutePath: string): string {
  let directory = dirname(absolutePath)

  while (isPathInside(projectRoot, directory)) {
    const packageJsonPath = join(directory, 'package.json')
    if (existsSync(packageJsonPath)) return packageJsonPath

    if (directory === projectRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return join(projectRoot, 'package.json')
}

function loadProjectPrettier(
  projectRoot: string,
  absolutePath: string
): Nullable<PrettierModuleLike> {
  const packageJsonPath = findNearestPackageJsonPath(projectRoot, absolutePath)
  if (projectPrettierCache.has(packageJsonPath))
    return projectPrettierCache.get(packageJsonPath) ?? null

  let module: Nullable<PrettierModuleLike> = null
  try {
    // 从目标文件最近 package 创建 require；Node 会继续向上查找，因此同时兼容子包自装和根目录 hoist。
    const projectRequire = createRequire(packageJsonPath)
    const entry = projectRequire.resolve('prettier')
    module = projectRequire(entry) as PrettierModuleLike
  } catch {
    module = null
  }

  projectPrettierCache.set(packageJsonPath, module)
  return module
}

export function clearWorkbenchProjectPrettierCache(projectRoot?: string): void {
  if (!projectRoot) {
    projectPrettierCache.clear()
    return
  }

  for (const packageJsonPath of projectPrettierCache.keys()) {
    if (isPathInside(projectRoot, packageJsonPath)) projectPrettierCache.delete(packageJsonPath)
  }
}

/**
 * 用项目自带 Prettier 格式化整篇内容。
 * @returns `null` 表示项目没装 Prettier / Prettier 无法处理该文件（应回退内置规则）；
 *          返回字符串表示 Prettier 已处理（即使内容未变，也应视为权威结果、不再回退）。
 */
export async function formatWorkbenchDocumentWithProjectPrettier(input: {
  projectRoot: string
  absolutePath: string
  content: string
}): Promise<Nullable<string>> {
  const prettier = loadProjectPrettier(input.projectRoot, input.absolutePath)
  if (!prettier) return null

  try {
    const info = await prettier.getFileInfo(input.absolutePath, { resolveConfig: true })
    if (info.ignored || !info.inferredParser) return null

    const config = (await prettier.resolveConfig(input.absolutePath, { editorconfig: true })) ?? {}
    const formatted = await prettier.format(input.content, {
      ...config,
      filepath: input.absolutePath,
    })
    return typeof formatted === 'string' ? formatted : null
  } catch {
    // 语法错误 / 未知 parser 等 → 放弃 Prettier，交给内置规则兜底。
    return null
  }
}

/** 内置通用格式化：JSON 美化；其它按去行尾空白 + 结尾补换行。返回 `null` 表示无法处理。 */
export function formatWorkbenchDocumentBuiltin(input: {
  extension: string
  content: string
}): Nullable<string> {
  if (input.extension === 'json') return formatWorkbenchJson(input.content)

  const trimmed = input.content
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
  return trimmed.length > 0 && !trimmed.endsWith('\n') ? `${trimmed}\n` : trimmed
}

interface WorkbenchJsonToken {
  kind: 'punctuation' | 'value' | 'comment'
  text: string
  /** 源文本里这个记号前面有换行（决定注释是跟在上一行末尾，还是独占一行）。 */
  newlineBefore: boolean
  /** `//` 注释：后面必须换行。 */
  lineComment?: boolean
}

const JsonStringPattern = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
const JsonNumberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const JsonLiteralPattern = /(?:true|false|null)(?![\w$])/y
const MaxJsonNestingDepth = 1_000

function readJsonPattern(pattern: RegExp, content: string, index: number): Nullable<string> {
  pattern.lastIndex = index
  return pattern.exec(content)?.[0] ?? null
}

/** JSON 字符串里不能直接出现控制字符（含换行）：得写成转义。 */
function readJsonString(content: string, index: number): Nullable<string> {
  const text = readJsonPattern(JsonStringPattern, content, index)
  if (!text) return null
  for (let offset = 0; offset < text.length; offset += 1)
    if (text.charCodeAt(offset) < 0x20) return null
  return text
}

/** 切成记号；遇到 JSON（含注释）里不该有的字符返回 null。 */
function tokenizeWorkbenchJson(content: string): Nullable<WorkbenchJsonToken[]> {
  const tokens: WorkbenchJsonToken[] = []
  let newlineBefore = false
  let index = 0
  while (index < content.length) {
    const character = content[index]!
    if (character === '\n') {
      newlineBefore = true
      index += 1
      continue
    }
    if (character === ' ' || character === '\t' || character === '\r' || character === '﻿') {
      index += 1
      continue
    }

    let token: Nullable<WorkbenchJsonToken> = null
    if ('{}[]:,'.includes(character)) {
      token = { kind: 'punctuation', text: character, newlineBefore }
    } else if (character === '/' && content[index + 1] === '/') {
      const end = content.indexOf('\n', index)
      const text = content.slice(index, end === -1 ? content.length : end).trimEnd()
      token = { kind: 'comment', text, newlineBefore, lineComment: true }
      index += text.length
      tokens.push(token)
      newlineBefore = false
      continue
    } else if (character === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2)
      if (end === -1) return null
      token = { kind: 'comment', text: content.slice(index, end + 2), newlineBefore }
    } else {
      const text =
        readJsonString(content, index)
        ?? readJsonPattern(JsonNumberPattern, content, index)
        ?? readJsonPattern(JsonLiteralPattern, content, index)
      if (!text) return null
      token = { kind: 'value', text, newlineBefore }
    }

    tokens.push(token)
    index += token.text.length
    newlineBefore = false
  }
  return tokens
}

/** 结构检查（忽略注释，允许 JSONC 的尾逗号）：不合法的 JSON 不动它，免得越排越乱。 */
function isWellFormedWorkbenchJson(tokens: readonly WorkbenchJsonToken[]): boolean {
  const significant = tokens.filter((token) => token.kind !== 'comment')
  let position = 0

  const parseValue = (depth: number): boolean => {
    const token = significant[position]
    if (!token || depth > MaxJsonNestingDepth) return false
    position += 1
    if (token.kind === 'value') return true
    if (token.text === '{') return parseMembers('}', true, depth)
    if (token.text === '[') return parseMembers(']', false, depth)
    return false
  }

  const parseMembers = (close: string, isObject: boolean, depth: number): boolean => {
    if (significant[position]?.text === close) {
      position += 1
      return true
    }
    while (true) {
      if (isObject) {
        const key = significant[position]
        if (key?.kind !== 'value' || !key.text.startsWith('"')) return false
        if (significant[position + 1]?.text !== ':') return false
        position += 2
      }
      if (!parseValue(depth + 1)) return false

      const next = significant[position]
      position += 1
      if (next?.text === close) return true
      if (next?.text !== ',') return false
      if (significant[position]?.text === close) {
        position += 1
        return true
      }
    }
  }

  return parseValue(0) && position === significant.length
}

/**
 * 按记号重排 JSON（兼容注释与尾逗号），缩进两格、成员各占一行，与 `JSON.stringify(value, null, 2)` 的
 * 版式一致。不经 `JSON.parse`：大整数、`1.0`、字符串里的转义写法、重复的键都原样保留，注释跟着原来的位置走。
 * 不合法时返回 null。
 */
export function formatWorkbenchJson(content: string, indentUnit = '  '): Nullable<string> {
  const tokens = tokenizeWorkbenchJson(content)
  if (!tokens || !isWellFormedWorkbenchJson(tokens)) return null

  let output = ''
  let depth = 0
  let pending: 'none' | 'space' | 'newline' = 'none'
  let previous: Nullable<WorkbenchJsonToken> = null
  const breakLine = (): void => {
    output += `\n${indentUnit.repeat(depth)}`
  }

  for (const token of tokens) {
    if (token.kind === 'comment') {
      // 原来跟在上一个记号后面的注释留在行尾，独占一行的仍独占一行。
      if (previous && !token.newlineBefore) output += ` ${token.text}`
      else {
        if (previous) breakLine()
        output += token.text
      }
      if (token.lineComment) pending = 'newline'
    } else if (token.text === '}' || token.text === ']') {
      depth -= 1
      const closesEmpty =
        previous?.kind === 'punctuation' && (previous.text === '{' || previous.text === '[')
      if (!closesEmpty) breakLine()
      output += token.text
      pending = 'none'
    } else if (token.text === ',' || token.text === ':') {
      // 行注释后面不能再接同一行的标点，否则标点就进了注释。
      if (previous?.lineComment) breakLine()
      output += token.text
      pending = token.text === ',' ? 'newline' : 'space'
    } else {
      const afterComment = previous?.kind === 'comment'
      if (pending === 'newline' || (afterComment && token.newlineBefore)) breakLine()
      else if (pending === 'space' || afterComment) output += ' '
      output += token.text
      if (token.text === '{' || token.text === '[') {
        depth += 1
        pending = 'newline'
      } else {
        pending = 'none'
      }
    }
    previous = token
  }

  return `${output}\n`
}

/** 把「整篇替换」表达成一条覆盖全文档的语言服务编辑（1 基行列，前端 applier 会映射成 [0, len)）。 */
export function buildWholeDocumentReplaceEdit(
  content: string,
  formatted: string
): WorkbenchLanguageServiceTextEdit {
  const lines = content.split('\n')
  return {
    range: {
      startLine: 1,
      startColumn: 1,
      endLine: lines.length,
      endColumn: (lines.at(-1)?.length ?? 0) + 1,
    },
    newText: formatted,
  }
}
