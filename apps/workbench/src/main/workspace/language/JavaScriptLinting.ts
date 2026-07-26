import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import type { WorkbenchLanguageServiceDiagnostic } from '@velaros-ai/workbench/contracts'

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

const projectEslintCache = new Map<string, ProjectEslintEntry>()

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
  if (!projectRoot) {
    projectEslintCache.clear()
    return
  }

  for (const packageJsonPath of projectEslintCache.keys()) {
    if (isPathInside(projectRoot, packageJsonPath)) projectEslintCache.delete(packageJsonPath)
  }
}

export async function getWorkbenchJavaScriptLintDiagnostics(input: {
  projectRoot: string
  absolutePath: string
  relativePath: string
  content: string
}): Promise<WorkbenchLanguageServiceDiagnostic[]> {
  const eslint = loadProjectEslint(input.projectRoot, input.absolutePath).instance
  if (!eslint) return []

  try {
    const results = await eslint.lintText(input.content, {
      filePath: input.absolutePath,
      warnIgnored: false,
    })
    return results.flatMap((result) =>
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
    )
  } catch {
    // 项目可能没有 ESLint 配置，或其插件与当前 Node 运行时不兼容；TS 诊断仍然可用。
    return []
  }
}
