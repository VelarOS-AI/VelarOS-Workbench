/**
 * 项目搜索面板的结果模型：磁盘上搜到的文件与编辑器里开着的文件合成一张按路径排好的结果表，再展开成一行行
 * （虚拟列表按行渲染，每行一样高）。纯函数，不碰 React 与宿主。
 *
 * 开着的文件以编辑器里的正文为准：main 不读它们，只报它们在不在搜索范围里；这里用同一套匹配规则在正文上搜，
 * 替换也在编辑器里做（能撤销，不和没保存的改动打架）。
 */
import type { WorkbenchTranslateParams } from '@renderer/i18n'

import type {
  WorkbenchContentSearchFileResult,
  WorkbenchContentSearchMatchResult,
  WorkbenchDirectoryEntry,
} from '@shared/contracts'
import { compareWorkbenchSearchPaths } from '@shared/workbenchSearchGlob'
import {
  buildWorkbenchTextSearchPreview,
  scanWorkbenchTextSearch,
  type WorkbenchTextSearchMatcher,
  workbenchTextSearchRangeKey,
} from '@shared/workbenchTextSearch'

/** 结果里的一个文件。 */
export interface WorkbenchProjectSearchFile extends WorkbenchContentSearchFileResult {
  /** 结果从哪来：编辑器里开着的正文（替换在编辑器里做），或磁盘（替换由 main 写盘）。 */
  source: 'editor' | 'disk'
  fileName: string
  /** 所在目录，工程根目录下的文件为空串。 */
  directory: string
}

/** 虚拟列表的一行。 */
export type WorkbenchProjectSearchRow =
  | { kind: 'entries'; key: string; count: number; collapsed: boolean }
  | { kind: 'entry'; key: string; entry: WorkbenchDirectoryEntry }
  | { kind: 'file'; key: string; file: WorkbenchProjectSearchFile; collapsed: boolean }
  | {
      kind: 'match'
      key: string
      file: WorkbenchProjectSearchFile
      match: WorkbenchContentSearchMatchResult
    }
  | { kind: 'more'; key: string; file: WorkbenchProjectSearchFile; hidden: number }

export interface WorkbenchProjectSearchSummary {
  matchCount: number
  fileCount: number
}

const CountMessageKeys = {
  match: ['workbench.projectSearchMatchCountOne', 'workbench.projectSearchMatchCountOther'],
  file: ['workbench.projectSearchFileCountOne', 'workbench.projectSearchFileCountOther'],
} as const

/** 「1 match」「3 matches」「3 处」：按数量挑单数或复数的写法（中文两种一样）。 */
export function formatWorkbenchProjectSearchCount(
  t: (key: string, params?: WorkbenchTranslateParams) => string,
  unit: keyof typeof CountMessageKeys,
  count: number
): string {
  const [one, other] = CountMessageKeys[unit]
  return t(count === 1 ? one : other, { count })
}

/** 在一段正文（编辑器里开着的文件）上搜：匹配数全，最多列出 limit 处。 */
export function searchWorkbenchEditorText(options: {
  path: string
  content: string
  modifiedAt: number
  size: number
  matcher: WorkbenchTextSearchMatcher
  limit: number
}): WorkbenchContentSearchFileResult {
  const matches: WorkbenchContentSearchMatchResult[] = []
  let matchCount = 0
  scanWorkbenchTextSearch(options.content, options.matcher, (hit) => {
    matchCount += 1
    if (matches.length >= options.limit) return

    const preview = buildWorkbenchTextSearchPreview(options.content, hit)
    matches.push({
      line: hit.line,
      column: hit.column,
      endLine: hit.endLine,
      endColumn: hit.endColumn,
      excerpt: preview.text,
      excerptMatchStart: preview.matchStart,
      excerptMatchEnd: preview.matchEnd,
    })
  })
  return {
    path: options.path,
    modifiedAt: options.modifiedAt,
    size: options.size,
    matchCount,
    matches,
  }
}

/**
 * 合成结果表：编辑器里开着的文件（editorFiles，含没有匹配的）盖过磁盘上的结果；没有匹配的文件不列。
 * 按目录一层层排好（与 main 出结果的顺序一致，边搜边来的结果不跳来跳去）。
 */
export function mergeWorkbenchProjectSearchFiles(
  diskFiles: ReadonlyMap<string, WorkbenchContentSearchFileResult>,
  editorFiles: ReadonlyMap<string, WorkbenchContentSearchFileResult>
): WorkbenchProjectSearchFile[] {
  const files: WorkbenchProjectSearchFile[] = []
  for (const file of editorFiles.values())
    if (file.matchCount > 0) files.push(decorate(file, 'editor'))
  for (const [path, file] of diskFiles)
    if (!editorFiles.has(path) && file.matchCount > 0) files.push(decorate(file, 'disk'))
  return files.sort((left, right) => compareWorkbenchSearchPaths(left.path, right.path))
}

export function summarizeWorkbenchProjectSearch(
  files: readonly WorkbenchProjectSearchFile[]
): WorkbenchProjectSearchSummary {
  let matchCount = 0
  for (const file of files) matchCount += file.matchCount
  return { matchCount, fileCount: files.length }
}

/** 展开成一行行：文件名命中的一组在最上面，然后每个文件一行、下面是它的匹配（收起的文件不展开）。 */
export function buildWorkbenchProjectSearchRows(options: {
  entries: readonly WorkbenchDirectoryEntry[]
  entriesCollapsed: boolean
  files: readonly WorkbenchProjectSearchFile[]
  collapsedPaths: ReadonlySet<string>
}): WorkbenchProjectSearchRow[] {
  const rows: WorkbenchProjectSearchRow[] = []
  if (options.entries.length > 0) {
    rows.push({
      kind: 'entries',
      key: 'entries',
      count: options.entries.length,
      collapsed: options.entriesCollapsed,
    })
    if (!options.entriesCollapsed)
      for (const entry of options.entries) rows.push({ kind: 'entry', key: `entry:${entry.path}`, entry })
  }

  for (const file of options.files) {
    const collapsed = options.collapsedPaths.has(file.path)
    rows.push({ kind: 'file', key: `file:${file.path}`, file, collapsed })
    if (collapsed) continue

    for (const match of file.matches)
      rows.push({ kind: 'match', key: workbenchProjectSearchMatchKey(file.path, match), file, match })
    const hidden = file.matchCount - file.matches.length
    if (hidden > 0) rows.push({ kind: 'more', key: `more:${file.path}`, file, hidden })
  }
  return rows
}

/** 键盘上下挑的、回车打开的行：命中的文件名与每一处匹配。 */
export function isOpenableWorkbenchProjectSearchRow(row: WorkbenchProjectSearchRow): boolean {
  return row.kind === 'entry' || row.kind === 'match'
}

export function workbenchProjectSearchMatchKey(
  path: string,
  match: Pick<WorkbenchContentSearchMatchResult, 'line' | 'column' | 'endLine' | 'endColumn'>
): string {
  return `match:${path}\u0000${workbenchTextSearchRangeKey(match)}`
}

function decorate(
  file: WorkbenchContentSearchFileResult,
  source: WorkbenchProjectSearchFile['source']
): WorkbenchProjectSearchFile {
  const slash = file.path.lastIndexOf('/')
  return {
    ...file,
    source,
    fileName: slash === -1 ? file.path : file.path.slice(slash + 1),
    directory: slash === -1 ? '' : file.path.slice(0, slash),
  }
}
