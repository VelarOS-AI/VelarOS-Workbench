/**
 * 内容搜索要搜的文件清单：工程相对路径（`/` 分隔），按目录一层层排好（见 workbenchSearchPathSortKey）。
 *
 * - Git 仓库：`git ls-files --stage` 列被跟踪的文件，`git ls-files --others --exclude-standard` 列没被忽略的
 *   新文件——.gitignore、.git/info/exclude 与全局忽略文件都算数，一次搜索只问这两次，不逐个目录去问。
 *   清单里的子模块与没被跟踪的嵌套仓库在它们自己里面再这样列一次。
 * - 不是 Git 仓库、Git 用不了，或者 Git 什么也没列出来（工程目录本身被上层仓库忽略了）：逐个目录遍历。
 *
 * 两种方式都不进内部目录（`.git`、`.codegraph`、`.data`）与依赖目录（`node_modules`），被跟踪了也不进。
 * 遍历时还跳过根目录下的构建产物（`build` / `dist` / `out`）与点号开头的目录（`.venv`、`.next` 之类常常
 * 很大，又没有忽略规则可依）；Git 仓库里这些交给 .gitignore 决定。点号开头的文件（`.env`）都搜。
 * 符号链接不跟：它指向的文件在工程里的话，按那个文件自己的路径列出来。
 *
 * 快速打开按文件名找文件用的是另一份清单（SearchIndex.listProjectFiles）：那份不看 .gitignore。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { execa } from 'execa'

import {
  isWorkbenchSearchDirectoryExcluded,
  isWorkbenchSearchPathIncluded,
  type WorkbenchSearchPathFilter,
  workbenchSearchPathSortKey,
} from '@shared/workbenchSearchGlob'

import {
  isGeneratedProjectDirectory,
  isInternalProjectDirectory,
  shouldSkipProjectDirectory,
} from './WorkbenchSkippedDirectories'

interface WorkbenchContentSearchFileListingOptions {
  filter: WorkbenchSearchPathFilter
  signal?: AbortSignal
}

/** 嵌套仓库最多往里列这么多层。 */
const MaxNestedRepositoryDepth = 4
/** `git ls-files` 输出的上限：几十万个文件的仓库也够。 */
const GitListingMaxBytes = 256 * 1024 * 1024
const GitSymlinkMode = '120000'
const GitSubmoduleMode = '160000'

export async function listWorkbenchContentSearchFiles(
  projectRoot: string,
  options: WorkbenchContentSearchFileListingOptions
): Promise<string[]> {
  const paths: string[] = []
  await listDirectory(projectRoot, '', options, paths, 0)
  return sortWorkbenchSearchPaths(paths)
}

export function sortWorkbenchSearchPaths(paths: readonly string[]): string[] {
  return paths
    .map((path) => ({ path, key: workbenchSearchPathSortKey(path) }))
    .sort((left, right) =>
      left.key !== right.key
        ? left.key < right.key ? -1 : 1
        : left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    )
    .map((entry) => entry.path)
}

/** 路径里有没有一段是不搜的目录：内部目录与依赖目录，任何一层都不搜。 */
export function isInsideUnsearchedDirectory(path: string): boolean {
  const segments = path.split('/')
  for (let index = 0; index < segments.length - 1; index += 1) {
    const name = segments[index]!
    if (isInternalProjectDirectory(name) || isGeneratedProjectDirectory(name, false)) return true
  }
  return false
}

/** 列出 directory（工程相对，空串是根目录）里的文件：能问 Git 就问 Git，否则遍历。 */
async function listDirectory(
  projectRoot: string,
  directory: string,
  options: WorkbenchContentSearchFileListingOptions,
  paths: string[],
  depth: number
): Promise<void> {
  const listed = await listGitFiles(projectRoot, directory, options)
  if (!listed) {
    await walkDirectory(projectRoot, directory, options, paths)
    return
  }

  for (const path of listed.files) {
    if (!isInsideUnsearchedDirectory(path) && isWorkbenchSearchPathIncluded(options.filter, path))
      paths.push(path)
  }
  for (const nested of listed.nestedRepositories) {
    if (options.signal?.aborted) return
    if (
      depth >= MaxNestedRepositoryDepth
      || isInsideUnsearchedDirectory(`${nested}/`)
      || isWorkbenchSearchDirectoryExcluded(options.filter, nested)
    )
      continue
    await listDirectory(projectRoot, nested, options, paths, depth + 1)
  }
}

interface GitFileListing {
  files: string[]
  /** 子模块与没被跟踪的嵌套仓库（工程相对路径）。 */
  nestedRepositories: string[]
}

/** 不是 Git 仓库、Git 出错或什么也没列出来时返回 null，由调用方改为遍历。 */
async function listGitFiles(
  projectRoot: string,
  directory: string,
  options: WorkbenchContentSearchFileListingOptions
): Promise<Nullable<GitFileListing>> {
  const cwd = directory ? join(projectRoot, directory) : projectRoot
  const prefix = directory ? `${directory}/` : ''
  const [tracked, untracked] = await Promise.all([
    runGitListing(cwd, ['ls-files', '--stage', '-z'], options.signal),
    runGitListing(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], options.signal),
  ])
  if (tracked === null || untracked === null) return null

  const files = new Set<string>()
  const nestedRepositories = new Set<string>()
  for (const record of tracked) {
    // `<mode> <object> <stage>\t<path>`；有冲突的文件每个 stage 各一行。
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const mode = record.slice(0, record.indexOf(' '))
    const path = prefix + record.slice(tab + 1)
    if (mode === GitSubmoduleMode) nestedRepositories.add(path)
    else if (mode !== GitSymlinkMode) files.add(path)
  }
  for (const record of untracked) {
    // 没被跟踪的嵌套仓库列成 `dir/`，Git 不进去。
    if (record.endsWith('/')) nestedRepositories.add(prefix + record.slice(0, -1))
    else files.add(prefix + record)
  }
  if (files.size === 0 && nestedRepositories.size === 0) return null

  return { files: [...files], nestedRepositories: [...nestedRepositories] }
}

async function runGitListing(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal | undefined
): Promise<Nullable<string[]>> {
  try {
    const result = await execa('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      reject: false,
      stdin: 'ignore',
      stderr: 'ignore',
      maxBuffer: GitListingMaxBytes,
      cancelSignal: signal,
    })
    if (result.failed) return null
    return result.stdout.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

async function walkDirectory(
  projectRoot: string,
  directory: string,
  options: WorkbenchContentSearchFileListingOptions,
  paths: string[]
): Promise<void> {
  if (options.signal?.aborted) return

  const entries = await readdir(directory ? join(projectRoot, directory) : projectRoot, {
    withFileTypes: true,
  }).catch(() => [])
  for (const entry of entries) {
    const path = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (
        entry.name.startsWith('.')
        || shouldSkipProjectDirectory(entry.name, !directory)
        || isWorkbenchSearchDirectoryExcluded(options.filter, path)
      )
        continue
      await walkDirectory(projectRoot, path, options, paths)
    } else if (entry.isFile() && isWorkbenchSearchPathIncluded(options.filter, path)) {
      paths.push(path)
    }
  }
}
