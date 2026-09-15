import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import type { WorkbenchLanguageServiceDiagnostic } from '@shared/contracts'

interface EslintMessageLike {
  ruleId?: Nullable<string>
  severity: number
  fatal?: boolean
  message: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
}

interface EslintResultLike {
  messages: EslintMessageLike[]
}

interface EslintInstanceLike {
  lintText(
    content: string,
    options: { filePath: string; warnIgnored: boolean }
  ): Promise<EslintResultLike[]>
}

interface EslintConstructorLike {
  new (options: {
    cwd: string
    errorOnUnmatchedPattern: boolean
    fix: boolean
    warnIgnored: boolean
  }): EslintInstanceLike
}

interface EslintModuleLike {
  ESLint?: EslintConstructorLike
}

interface ProjectEslintEntry {
  packageJsonPath: string
  instance: Nullable<EslintInstanceLike>
}

interface CachedLintResult {
  content: string
  diagnostics: WorkbenchLanguageServiceDiagnostic[]
}

const MaxCachedLintResults = 64
const projectEslintCache = new Map<string, ProjectEslintEntry>()
/**
 * 按文件缓存最近一次的 lint 结果：编辑器的 linter 与问题面板、外部改动后的复核会拿同一份文本再问一遍，
 * 类型感知的 ESLint 一次要几十到几百毫秒。磁盘上任何文件变了就整体作废（{@link clearWorkbenchProjectEslintResults}），
 * 别的标签里没保存的改动不作废——VS Code 的 ESLint 也只在文档自己变了时重新 lint。
 */
const lintResultCache = new Map<string, CachedLintResult>()

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

function loadProjectEslint(projectRoot: string, absolutePath: string): ProjectEslintEntry {
  const packageJsonPath = findNearestPackageJsonPath(projectRoot, absolutePath)
  const cached = projectEslintCache.get(packageJsonPath)
  if (cached) return cached

  let instance: Nullable<EslintInstanceLike> = null
  try {
    const projectRequire = createRequire(packageJsonPath)
    const eslintEntry = projectRequire.resolve('eslint')
    const eslintModule = projectRequire(eslintEntry) as EslintModuleLike
    if (eslintModule.ESLint) {
      instance = new eslintModule.ESLint({
        cwd: dirname(packageJsonPath),
        errorOnUnmatchedPattern: false,
        fix: false,
        warnIgnored: false,
      })
    }
  } catch {
    instance = null
  }

  const entry = { packageJsonPath, instance }
  projectEslintCache.set(packageJsonPath, entry)
  return entry
}

export function clearWorkbenchProjectEslintCache(projectRoot?: string): void {
  clearWorkbenchProjectEslintResults(projectRoot)
  if (!projectRoot) {
    projectEslintCache.clear()
    return
  }

  for (const packageJsonPath of projectEslintCache.keys()) {
    if (isPathInside(projectRoot, packageJsonPath)) projectEslintCache.delete(packageJsonPath)
  }
}

/** 项目里有文件在磁盘上变了：缓存的 lint 结果可能已经过时（类型感知规则看得到别的文件），整体作废。 */
export function clearWorkbenchProjectEslintResults(projectRoot?: string): void {
  if (!projectRoot) {
    lintResultCache.clear()
    return
  }

  for (const absolutePath of lintResultCache.keys()) {
    if (isPathInside(projectRoot, absolutePath)) lintResultCache.delete(absolutePath)
  }
}

function rememberLintResult(
  absolutePath: string,
  content: string,
  diagnostics: WorkbenchLanguageServiceDiagnostic[]
): WorkbenchLanguageServiceDiagnostic[] {
  lintResultCache.delete(absolutePath)
  lintResultCache.set(absolutePath, { content, diagnostics })
  if (lintResultCache.size > MaxCachedLintResults) {
    const oldest = lintResultCache.keys().next().value
    if (oldest !== undefined) lintResultCache.delete(oldest)
  }
  return diagnostics
}

export async function getWorkbenchJavaScriptLintDiagnostics(input: {
  projectRoot: string
  absolutePath: string
  relativePath: string
  content: string
}): Promise<WorkbenchLanguageServiceDiagnostic[]> {
  const eslint = loadProjectEslint(input.projectRoot, input.absolutePath).instance
  if (!eslint) return []

  const cached = lintResultCache.get(input.absolutePath)
  if (cached && cached.content === input.content) return cached.diagnostics

  try {
    const results = await eslint.lintText(input.content, {
      filePath: input.absolutePath,
      warnIgnored: false,
    })
    return rememberLintResult(input.absolutePath, input.content, results.flatMap((result) =>
      result.messages.map((message) => {
        const startLine = Math.max(1, message.line ?? 1)
        const startColumn = Math.max(1, message.column ?? 1)
        const endLine = Math.max(startLine, message.endLine ?? startLine)
        const endColumn = Math.max(
          endLine === startLine ? startColumn + 1 : 1,
          message.endColumn ?? startColumn + 1
        )

        return {
          path: input.relativePath,
          severity: message.fatal || message.severity >= 2 ? 'error' : 'warning',
          message: message.ruleId ? `${message.message} (${message.ruleId})` : message.message,
          source: 'eslint',
          range: {
            startLine,
            startColumn,
            endLine,
            endColumn,
          },
        }
      })
    ))
  } catch {
    // 项目可能没有 ESLint 配置，或其插件与当前 Node 运行时不兼容；TS 诊断仍然可用。
    return rememberLintResult(input.absolutePath, input.content, [])
  }
}
