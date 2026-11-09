/**
 * 从编辑器里跑测试：认出项目用的是 Vitest 还是 Jest，拼出「只跑这个文件里的这个测试」的命令。
 *
 * 只认 JS / TS 的测试文件和这两个运行器；认的依据是离测试文件最近的 `package.json`（依赖、脚本、`jest` 配置段）
 * 和它旁边的配置文件，不执行项目里的任何代码。
 */
import { tsxLanguage } from '@codemirror/lang-javascript'
import type { SyntaxNode } from '@lezer/common'

import { isPlainObject, isString } from '@velaros-ai/velaros/core'

import type { WorkbenchDebuggerLaunchTarget } from '@shared/workbenchDebugger'

import type { PackageManagerCommand } from './workbenchPackageScriptCommand'
import { quoteWorkbenchShellArgument } from './workbenchShellQuote'

export type WorkbenchTestRunnerKind = 'vitest' | 'jest'

/** 一个测试文件归哪个运行器跑、在哪个目录跑、用哪个包管理器起。 */
export interface WorkbenchTestRunnerProject {
  runner: WorkbenchTestRunnerKind
  /** 认出运行器的那个 `package.json` 所在的目录（项目里的相对路径，空串是项目根）：命令在这里跑。 */
  packageDir: string
  packageManager: PackageManagerCommand
}

/** 依据有多硬：配置文件（或 `package.json` 里的 `jest` 段）> 依赖 > 脚本里提到。 */
type WorkbenchTestRunnerEvidence = 1 | 2 | 3

export type WorkbenchTestRunnerEvidenceMap = Partial<
  Record<WorkbenchTestRunnerKind, WorkbenchTestRunnerEvidence>
>

/**
 * 给一个测试文件认出来的结果：离它最近、有运行器依据的那个目录。两个运行器都有依据时先都留着，真去跑的时候
 * 再看这个文件自己引的是谁（见 {@link pickWorkbenchTestRunner}）。
 */
export interface WorkbenchTestRunnerDetection {
  evidence: WorkbenchTestRunnerEvidenceMap
  packageDir: string
  packageManager: PackageManagerCommand
}

/** 认运行器要问文件系统的两件事（主进程那边只看项目里的文件）。 */
export interface WorkbenchTestRunnerProbe {
  /** 这些路径里哪些是项目里的文件。 */
  findExistingFiles: (paths: string[]) => Promise<string[]>
  /** 读一个文本文件；读不了给 null。 */
  readFile: (path: string) => Promise<Nullable<string>>
}

const JavaScriptTestExtensions = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'])
const TestFileNamePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/iu

const ConfigFileExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']
const RunnerConfigFileNames: Record<WorkbenchTestRunnerKind, readonly string[]> = {
  vitest: [
    ...ConfigFileExtensions.map((extension) => `vitest.config.${extension}`),
    ...ConfigFileExtensions.map((extension) => `vitest.workspace.${extension}`),
    'vitest.workspace.json',
  ],
  jest: [
    ...ConfigFileExtensions.map((extension) => `jest.config.${extension}`),
    'jest.config.json',
  ],
}
const RunnerDependencyNames: Record<WorkbenchTestRunnerKind, readonly string[]> = {
  vitest: ['vitest'],
  jest: ['jest', 'jest-cli', '@jest/core', 'ts-jest', 'babel-jest'],
}
const LockFilePackageManagers: ReadonlyArray<readonly [string, PackageManagerCommand]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]
const PackageManagers = new Set<PackageManagerCommand>(['bun', 'npm', 'pnpm', 'yarn'])

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\/+/u, '')
}

/** JS / TS 的测试文件：`*.test.*`、`*.spec.*`，或者放在 `__tests__` 目录里。 */
export function isWorkbenchJavaScriptTestFilePath(path: Nullable<string>): boolean {
  if (!path) return false

  const normalized = normalizePath(path)
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  if (!fileName.includes('.') || !JavaScriptTestExtensions.has(extension)) return false

  return TestFileNamePattern.test(fileName) || `/${normalized}`.includes('/__tests__/')
}

/** 从测试文件所在的目录一路往上到项目根（空串）：最近的在前。 */
export function listWorkbenchTestRunnerLookupDirectories(filePath: string): string[] {
  const segments = normalizePath(filePath).split('/').slice(0, -1)
  const directories: string[] = []
  for (let depth = segments.length; depth >= 0; depth -= 1)
    directories.push(segments.slice(0, depth).join('/'))
  return directories
}

export function joinWorkbenchProjectPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name
}

/** 在一个目录里要看的文件：`package.json`、两个运行器的配置文件、各包管理器的锁文件。 */
export function listWorkbenchTestRunnerProbePaths(directory: string): string[] {
  return [
    'package.json',
    ...RunnerConfigFileNames.vitest,
    ...RunnerConfigFileNames.jest,
    ...LockFilePackageManagers.map(([name]) => name),
  ].map((name) => joinWorkbenchProjectPath(directory, name))
}

function readManifest(content: Nullable<string>): Nullable<Record<string, unknown>> {
  if (!content) return null
  try {
    const manifest: unknown = JSON.parse(content)
    return isPlainObject(manifest) ? manifest : null
  } catch {
    // arch-guard:silent-catch-ok 正在编辑、暂时不完整的 package.json：按没有依据处理，存好了再认。
    return null
  }
}

/**
 * 一个目录里有哪些运行器的依据。`fileNames` 是这个目录里确实存在的文件名（不带目录），`manifestContent` 是它的
 * `package.json` 原文（没有就不给）。
 */
export function readWorkbenchTestRunnerEvidence(
  fileNames: readonly string[],
  manifestContent: Nullable<string>
): WorkbenchTestRunnerEvidenceMap {
  const present = new Set(fileNames)
  const manifest = readManifest(manifestContent) ?? {}
  const dependencies = new Set(
    ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
      (section) => {
        const entries = manifest[section]
        return isPlainObject(entries) ? Object.keys(entries) : []
      }
    )
  )
  const scriptEntries = manifest.scripts
  const scripts = isPlainObject(scriptEntries)
    ? Object.values(scriptEntries).filter(isString).join('\n')
    : ''

  const evidence: WorkbenchTestRunnerEvidenceMap = {}
  for (const runner of ['vitest', 'jest'] as const) {
    if (
      RunnerConfigFileNames[runner].some((name) => present.has(name)) ||
      (runner === 'jest' && isPlainObject(manifest.jest))
    )
      evidence[runner] = 3
    else if (RunnerDependencyNames[runner].some((name) => dependencies.has(name)))
      evidence[runner] = 2
    else if (new RegExp(`(?:^|[^\\w-])${runner}(?:$|[^\\w-])`, 'mu').test(scripts))
      evidence[runner] = 1
  }
  return evidence
}

/**
 * 两个运行器都有依据时选哪个：测试文件自己引了谁就是谁（`import … from 'vitest'` / `'@jest/globals'`），
 * 否则依据更硬的那个，一样硬选 Vitest。都没有依据返回 null。
 */
export function pickWorkbenchTestRunner(
  evidence: WorkbenchTestRunnerEvidenceMap,
  imported: Nullable<WorkbenchTestRunnerKind> = null
): Nullable<WorkbenchTestRunnerKind> {
  const vitest = evidence.vitest ?? 0
  const jest = evidence.jest ?? 0
  if (!vitest && !jest) return null
  if (imported && evidence[imported]) return imported
  return jest > vitest ? 'jest' : 'vitest'
}

/** 候选导入自身不完整时不用错误恢复树猜模块；其它位置的编辑中语法错误不影响已完整的导入。 */
function hasTestRunnerImportSyntaxError(node: SyntaxNode): boolean {
  let invalid = false
  node.cursor().iterate((current) => {
    if (current.type.isError) invalid = true
  })
  return invalid
}

/** 只看开头一段源码中的静态 import 或直接 require 的字符串参数；不执行项目代码。 */
export function readWorkbenchTestRunnerImport(source: string): Nullable<WorkbenchTestRunnerKind> {
  const head = source.slice(0, 20_000)
  let imported: Nullable<WorkbenchTestRunnerKind> = null
  tsxLanguage.parser.parse(head).iterate({
    enter(current) {
      const node = current.node
      let specifier: Nullable<SyntaxNode> = null
      if (node.name === 'ImportDeclaration') {
        specifier = node.getChild('String')
      } else if (node.name === 'CallExpression') {
        const callee = node.firstChild
        if (callee?.name !== 'VariableName' || head.slice(callee.from, callee.to) !== 'require')
          return
        specifier = node.getChild('ArgList')?.firstChild?.nextSibling ?? null
        while (specifier?.name === 'BlockComment' || specifier?.name === 'LineComment')
          specifier = specifier.nextSibling
      }
      if (specifier?.name !== 'String') return
      const literal = head.slice(specifier.from, specifier.to)
      const runner =
        literal === "'vitest'" || literal === '"vitest"'
          ? 'vitest'
          : literal === "'@jest/globals'" || literal === '"@jest/globals"'
            ? 'jest'
            : null
      if (!runner || hasTestRunnerImportSyntaxError(node)) return
      // 两种运行器都被实际引入时保留既有 Vitest 优先级。
      if (runner === 'vitest' || imported === null) imported = runner
    },
  })
  return imported
}

/** 这个目录说的包管理器：`package.json` 的 `packageManager` 字段优先，其次看锁文件；看不出来返回 null。 */
export function readWorkbenchTestPackageManager(
  fileNames: readonly string[],
  manifestContent: Nullable<string>
): Nullable<PackageManagerCommand> {
  const declared = readManifest(manifestContent)?.packageManager
  if (isString(declared)) {
    const name = declared.split('@')[0] as PackageManagerCommand
    if (PackageManagers.has(name)) return name
  }

  const present = new Set(fileNames)
  return LockFilePackageManagers.find(([name]) => present.has(name))?.[1] ?? null
}

/**
 * 从测试文件所在的目录往上找：第一个有运行器依据的目录定下运行器与工作目录，包管理器取一路上最先说清楚的那个
 * （没人说就是 npm）。一层目录问一次文件系统，认到了就不再往上。都没有依据返回 null。
 */
export async function detectWorkbenchTestRunner(
  filePath: string,
  probe: WorkbenchTestRunnerProbe
): Promise<Nullable<WorkbenchTestRunnerDetection>> {
  let found: Nullable<Pick<WorkbenchTestRunnerDetection, 'evidence' | 'packageDir'>> = null
  let packageManager: Nullable<PackageManagerCommand> = null

  for (const directory of listWorkbenchTestRunnerLookupDirectories(filePath)) {
    const prefixLength = directory ? directory.length + 1 : 0
    const fileNames = (
      await probe.findExistingFiles(listWorkbenchTestRunnerProbePaths(directory))
    ).map((path) => normalizePath(path).slice(prefixLength))
    const manifestContent = fileNames.includes('package.json')
      ? await probe.readFile(joinWorkbenchProjectPath(directory, 'package.json'))
      : null

    packageManager ??= readWorkbenchTestPackageManager(fileNames, manifestContent)
    if (!found) {
      const evidence = readWorkbenchTestRunnerEvidence(fileNames, manifestContent)
      if (pickWorkbenchTestRunner(evidence)) found = { evidence, packageDir: directory }
    }
    if (found && packageManager) break
  }

  return found ? { ...found, packageManager: packageManager ?? 'npm' } : null
}

/** 各包管理器怎么起项目里装的可执行文件（不去网上装）。 */
export function getWorkbenchTestRunnerExecutable(
  runner: WorkbenchTestRunnerKind,
  packageManager: PackageManagerCommand
): string {
  switch (packageManager) {
    case 'bun':
      return `bunx --no-install ${runner}`
    case 'pnpm':
      return `pnpm exec ${runner}`
    case 'yarn':
      // `yarn run <可执行文件>` 在 Yarn 1 和新版里都把后面的参数原样交过去；`yarn exec` 在 Yarn 1 里会自己吃掉选项。
      return `yarn run ${runner}`
    case 'npm':
      return `npx --no-install ${runner}`
  }
}

/** `file` 相对 `directory` 的路径（都是项目里的相对路径）。 */
export function relativeWorkbenchTestFilePath(filePath: string, directory: string): string {
  const normalized = normalizePath(filePath)
  return directory && normalized.startsWith(`${directory}/`)
    ? normalized.slice(directory.length + 1)
    : normalized
}

export interface WorkbenchTestRunCommandOptions {
  project: WorkbenchTestRunnerProject
  /** 测试文件（项目里的相对路径）。 */
  filePath: string
  /** 只跑全名匹配这个正则的测试；不给跑整个文件。 */
  pattern?: Nullable<string>
  windows: boolean
}

/**
 * 跑一次就退出（不进监听模式）、只跑这个文件的命令。Vitest 用 `run` 子命令加文件过滤；Jest 用
 * `--runTestsByPath`（按路径原样找文件，不把路径当正则）。`pattern` 经 `-t` 交给运行器按测试全名过滤。
 */
export function buildWorkbenchTestRunCommand({
  project,
  filePath,
  pattern,
  windows,
}: WorkbenchTestRunCommandOptions): string {
  const file = quoteWorkbenchShellArgument(
    relativeWorkbenchTestFilePath(filePath, project.packageDir),
    windows
  )
  const executable = getWorkbenchTestRunnerExecutable(project.runner, project.packageManager)
  const filter = pattern ? ` -t ${quoteWorkbenchShellArgument(pattern, windows)}` : ''
  return project.runner === 'vitest'
    ? `${executable} run ${file}${filter}`
    : `${executable} --runTestsByPath ${file}${filter}`
}

/**
 * 调试一个测试时怎么起运行器：测试代码得跑在一个连得上检查器的进程里。
 * - Vitest 自己认 `--inspect-brk`（主进程把开关接在命令末尾）；关掉文件并行，测试就在那一个带检查器的进程里跑。
 * - Jest 不认：由 node 带着检查器直接起它的可执行入口，`--runInBand` 让测试留在这个进程里。
 *
 * 停在断点上的时间不能算超时，两边都把单个测试的超时放开。
 */
export function buildWorkbenchTestDebugTarget({
  project,
  filePath,
  pattern,
  windows,
}: WorkbenchTestRunCommandOptions): WorkbenchDebuggerLaunchTarget {
  const file = quoteWorkbenchShellArgument(
    relativeWorkbenchTestFilePath(filePath, project.packageDir),
    windows
  )
  const filter = pattern ? ` -t ${quoteWorkbenchShellArgument(pattern, windows)}` : ''
  if (project.runner === 'vitest') {
    const executable = getWorkbenchTestRunnerExecutable('vitest', project.packageManager)
    return {
      kind: 'inspect-command',
      command: `${executable} run ${file}${filter} --no-file-parallelism --testTimeout=0`,
    }
  }
  return {
    kind: 'node-package-bin',
    packageName: 'jest',
    args: `--runInBand --runTestsByPath ${file}${filter} --testTimeout=100000000`,
  }
}
