import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import type { WorkbenchLanguageServiceTextEdit } from '@velaros-ai/workbench/contracts'

/**
 * 文档格式化：**项目 Prettier 优先，内置规则回退**。
 *
 * - 若目标项目自带 `prettier`（`<projectRoot>/node_modules/prettier`），就用它 + 项目配置
 *   （`.prettierrc`/`.editorconfig`）格式化，完全遵循项目规范。
 * - 项目没有 Prettier 时回到编辑器内置规则：JSON 走 `JSON.stringify` 美化，其它做去行尾空白
 *   + 结尾补换行（TS 家族的内置格式化在 {@link LanguageServices.getFormat} 里另走 TS 语言服务）。
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
  if (input.extension === 'json') {
    try {
      return `${JSON.stringify(JSON.parse(input.content), null, 2)}\n`
    } catch {
      return null
    }
  }

  const trimmed = input.content
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
  return trimmed.length > 0 && !trimmed.endsWith('\n') ? `${trimmed}\n` : trimmed
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
