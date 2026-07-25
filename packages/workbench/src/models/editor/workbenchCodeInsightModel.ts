import { isPresent } from '@velaros/core'
import type {
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchRunCommandResult,
} from '@velaros/core/types'

import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

import { isWorkbenchUnusedVariableDiagnosticCode } from './workbenchCodeMirrorDiagnostics'
import {
  buildWorkbenchEditorProblems,
  type WorkbenchEditorProblemKind,
} from './workbenchEditorModel'

export type WorkbenchProblemLocationKind = WorkbenchEditorProblemKind | 'command' | 'diagnostic'
export type WorkbenchProblemLocationSeverity = 'error' | 'hint' | 'warning'
export type WorkbenchProblemLocationSource = 'command' | 'editor'

export interface WorkbenchProblemLocation {
  id: string
  kind: WorkbenchProblemLocationKind
  severity: WorkbenchProblemLocationSeverity
  path: string
  fileName: string
  isActiveFile: boolean
  line: number
  column: number
  excerpt: string
  source: WorkbenchProblemLocationSource
  /** TypeScript diagnostic code when available (e.g. 2552). */
  code?: number
  isUnused?: boolean
}

export interface WorkbenchProblemFileGroup {
  path: string
  fileName: string
  directoryPath: string
  isActiveFile: boolean
  problems: WorkbenchProblemLocation[]
}

const MAX_PROBLEM_LOCATIONS = 200
const MAX_COMMAND_PROBLEM_LOCATIONS = 80
const COMMAND_MESSAGE_LIMIT = 220

export interface WorkbenchFileDiagnosticCounts {
  errorCount: number
  warningCount: number
}

export function countWorkbenchFileDiagnostics(
  diagnostics: LooseOptional<readonly WorkbenchLanguageServiceDiagnostic[]>
): WorkbenchFileDiagnosticCounts {
  let errorCount = 0
  let warningCount = 0

  for (const diagnostic of diagnostics ?? []) {
    if (diagnostic.severity === 'error') {
      errorCount++
      continue
    }

    if (diagnostic.severity === 'warning') {
      warningCount++
    }
  }

  return { errorCount, warningCount }
}

export function diagnosticCoversPosition(
  diagnostic: WorkbenchLanguageServiceDiagnostic,
  line: number,
  column: number
): boolean {
  const { startLine, startColumn, endLine, endColumn } = diagnostic.range
  if (line < startLine || line > endLine) return false
  if (line === startLine && column < startColumn) return false
  if (line === endLine && column >= endColumn) return false

  return true
}

export function countWorkbenchDiagnosticsAtPosition(
  diagnostics: LooseOptional<readonly WorkbenchLanguageServiceDiagnostic[]>,
  line: number,
  column: number
): WorkbenchFileDiagnosticCounts {
  let errorCount = 0
  let warningCount = 0

  for (const diagnostic of diagnostics ?? []) {
    if (!diagnosticCoversPosition(diagnostic, line, column)) continue

    if (diagnostic.severity === 'error') {
      errorCount++
      continue
    }

    if (diagnostic.severity === 'warning') {
      warningCount++
    }
  }

  return { errorCount, warningCount }
}

function compareWorkbenchDiagnosticPosition(
  left: WorkbenchLanguageServiceDiagnostic,
  right: WorkbenchLanguageServiceDiagnostic
): number {
  const leftRange = left.range
  const rightRange = right.range

  return (
    leftRange.startLine - rightRange.startLine ||
    leftRange.startColumn - rightRange.startColumn ||
    leftRange.endLine - rightRange.endLine ||
    leftRange.endColumn - rightRange.endColumn
  )
}

export function sortWorkbenchFileDiagnostics(
  diagnostics: LooseOptional<readonly WorkbenchLanguageServiceDiagnostic[]>
): WorkbenchLanguageServiceDiagnostic[] {
  return (diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning')
    .sort(compareWorkbenchDiagnosticPosition)
}

export function findWorkbenchDiagnosticIndexAtPosition(
  diagnostics: readonly WorkbenchLanguageServiceDiagnostic[],
  line: number,
  column: number
): number {
  for (let index = 0; index < diagnostics.length; index++) {
    if (diagnosticCoversPosition(diagnostics[index], line, column)) return index
  }

  return -1
}

export function resolveWorkbenchDiagnosticNavigationIndex({
  diagnostics,
  activeIndex,
  line,
  column,
  direction,
}: {
  diagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
  activeIndex: number
  line: number
  column: number
  direction: 'next' | 'previous'
}): number {
  if (!diagnostics.length) return -1

  if (activeIndex >= 0) {
    const delta = direction === 'next' ? 1 : -1
    return (activeIndex + delta + diagnostics.length) % diagnostics.length
  }

  if (direction === 'next') {
    const nextIndex = diagnostics.findIndex(
      (diagnostic) =>
        diagnostic.range.startLine > line ||
        (diagnostic.range.startLine === line && diagnostic.range.startColumn > column)
    )

    return nextIndex >= 0 ? nextIndex : 0
  }

  let previousIndex = -1

  for (let index = 0; index < diagnostics.length; index++) {
    const diagnostic = diagnostics[index]
    if (
      diagnostic.range.startLine < line ||
      (diagnostic.range.startLine === line && diagnostic.range.startColumn < column)
    ) {
      previousIndex = index
    }
  }

  return previousIndex >= 0 ? previousIndex : diagnostics.length - 1
}

const COMMAND_LOCATION_PATTERNS = [
  /^(?<path>(?:[A-Za-z]:)?[^:\n()]+?\.[A-Za-z0-9_.-]+)\((?<line>\d+),(?<column>\d+)\):\s*(?<message>.+)$/,
  /^(?<path>(?:[A-Za-z]:)?[^:\n]+?\.[A-Za-z0-9_.-]+):(?<line>\d+):(?<column>\d+):\s*(?<message>.+)$/,
  /^(?<path>(?:[A-Za-z]:)?[^:\n]+?\.[A-Za-z0-9_.-]+):(?<line>\d+):\s*(?<message>.+)$/,
]

function fileNameFromPath(path: string): string {
  return path.split('/').findLast((value) => !!value) ?? path
}

function normalizeWorkbenchPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

export function buildWorkbenchDiagnosticProblemId(
  path: string,
  diagnostic: WorkbenchLanguageServiceDiagnostic
): string {
  return `diagnostic:${path}:${diagnostic.range.startLine}:${diagnostic.range.startColumn}:${diagnostic.message}`
}

export function formatWorkbenchProblemDisplayMessage(problem: WorkbenchProblemLocation): string {
  const message = problem.excerpt.trim()
  if (!isPresent(problem.code)) return message

  const codePrefix = `TS${problem.code}:`
  if (message.startsWith(codePrefix)) return message

  return `${codePrefix} ${message}`
}

export function buildWorkbenchProblemDirectoryPath(
  path: string,
  projectRoot: LooseOptional<string>
): string {
  const normalizedPath = normalizeWorkbenchPath(path)
  const normalizedRoot = projectRoot ? normalizeWorkbenchPath(projectRoot).replace(/\/+$/g, '') : ''

  let relativePath = normalizedPath
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    relativePath = normalizedPath.slice(normalizedRoot.length + 1)
  }

  const slashIndex = relativePath.lastIndexOf('/')
  if (slashIndex <= 0) return ''

  return relativePath.slice(0, slashIndex)
}

export function groupWorkbenchProblemsByFile(
  problems: readonly WorkbenchProblemLocation[],
  projectRoot: LooseOptional<string>
): WorkbenchProblemFileGroup[] {
  const groups = new Map<string, WorkbenchProblemFileGroup>()

  for (const problem of problems) {
    const existing = groups.get(problem.path)
    if (existing) {
      existing.problems.push(problem)
      continue
    }

    groups.set(problem.path, {
      path: problem.path,
      fileName: problem.fileName,
      directoryPath: buildWorkbenchProblemDirectoryPath(problem.path, projectRoot),
      isActiveFile: problem.isActiveFile,
      problems: [problem],
    })
  }

  return [...groups.values()].sort((left, right) => {
    if (left.isActiveFile !== right.isActiveFile) return left.isActiveFile ? -1 : 1

    return left.path.localeCompare(right.path)
  })
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed

  return `${trimmed.slice(0, limit)}...`
}

function toPortablePath(path: string): string {
  return path
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
}

function normalizeCommandLocationPath(rawPath: string, projectRoot: string): Nullable<string> {
  const path = toPortablePath(rawPath.trim())
  const root = toPortablePath(projectRoot).replace(/\/+$/g, '')
  const normalizedPath = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

  if (
    !normalizedPath ||
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/node_modules/') ||
    normalizedPath.startsWith('node_modules/') ||
    normalizedPath.startsWith('<')
  ) return null

  return normalizedPath
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = +(value ?? Number.NaN)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function commandSeverity(message: string): WorkbenchProblemLocationSeverity {
  return /\b(error|failed|failure|exception|fatal)\b/i.test(message) ? 'error' : 'warning'
}

function buildCommandProblemLocations({
  commandResult,
  selectedFilePath,
}: {
  commandResult: Nullable<WorkbenchRunCommandResult>
  selectedFilePath: Nullable<string>
}): WorkbenchProblemLocation[] {
  if (!commandResult || commandResult.success) return []

  const lines = [commandResult.stderr, commandResult.stdout].filter((value) => !!value).join('\n').split('\n')
  const locations: WorkbenchProblemLocation[] = []
  const seen = new Set<string>()

  for (const line of lines) {
    if (locations.length >= MAX_COMMAND_PROBLEM_LOCATIONS) {
      break
    }

    const trimmedLine = line.trim()
    if (!trimmedLine) {
      continue
    }

    const match = COMMAND_LOCATION_PATTERNS.map((pattern) => pattern.exec(trimmedLine)).find(
      (candidate): candidate is RegExpExecArray => !!candidate
    )
    const groups = match?.groups
    if (!groups) {
      continue
    }

    const path = normalizeCommandLocationPath(groups.path ?? '', commandResult.projectRoot)
    if (!path) {
      continue
    }

    const problemLine = parsePositiveInteger(groups.line, 1)
    const column = parsePositiveInteger(groups.column, 1)
    const excerpt = truncate(groups.message ?? trimmedLine, COMMAND_MESSAGE_LIMIT)
    const key = `${path}:${problemLine}:${column}:${excerpt}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    locations.push({
      id: `command:${key}`,
      kind: 'command',
      severity: commandSeverity(excerpt),
      path,
      fileName: fileNameFromPath(path),
      isActiveFile: path === selectedFilePath,
      line: problemLine,
      column,
      excerpt,
      source: 'command',
    })
  }

  return locations
}

function severityRank(severity: WorkbenchProblemLocationSeverity): number {
  switch (severity) {
    case 'error': {
      return 0
    }
    case 'warning': {
      return 1
    }
    default: {
      return 2
    }
  }
}

function mapLanguageServiceDiagnosticSeverity(
  diagnostic: Pick<WorkbenchLanguageServiceDiagnostic, 'severity' | 'code'>
): WorkbenchProblemLocationSeverity {
  if (isWorkbenchUnusedVariableDiagnosticCode(diagnostic.code)) return 'warning'

  switch (diagnostic.severity) {
    case 'error': {
      return 'error'
    }
    case 'warning': {
      return 'warning'
    }
    default: {
      return 'hint'
    }
  }
}

function buildLanguageServiceProblemLocations({
  diagnosticsByPath,
  selectedFilePath,
}: {
  diagnosticsByPath: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>
  selectedFilePath: Nullable<string>
}): WorkbenchProblemLocation[] {
  const locations: WorkbenchProblemLocation[] = []

  for (const [path, diagnostics] of diagnosticsByPath) {
    for (const diagnostic of diagnostics) {
      locations.push({
        id: buildWorkbenchDiagnosticProblemId(path, diagnostic),
        kind: 'diagnostic',
        severity: mapLanguageServiceDiagnosticSeverity(diagnostic),
        path,
        fileName: fileNameFromPath(path),
        isActiveFile: path === selectedFilePath,
        line: diagnostic.range.startLine,
        column: diagnostic.range.startColumn,
        excerpt: truncate(diagnostic.message, COMMAND_MESSAGE_LIMIT),
        source: 'editor',
        code: diagnostic.code,
        isUnused: isWorkbenchUnusedVariableDiagnosticCode(diagnostic.code),
      })
    }
  }

  return locations
}

export function buildWorkbenchProblemLocations({
  commandResult = null,
  openTabs,
  selectedFilePath,
  diagnosticsByPath = new Map(),
}: {
  commandResult?: LooseOptional<WorkbenchRunCommandResult>
  openTabs: WorkbenchOpenEditorTab[]
  selectedFilePath: Nullable<string>
  diagnosticsByPath?: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>
}): WorkbenchProblemLocation[] {
  const languageServiceProblems = buildLanguageServiceProblemLocations({
    diagnosticsByPath,
    selectedFilePath,
  })
  const editorProblems = openTabs.flatMap((tab) =>
    buildWorkbenchEditorProblems(tab.content).map((problem) => ({
      ...problem,
      id: `${tab.path}:${problem.id}`,
      path: tab.path,
      fileName: fileNameFromPath(tab.path),
      isActiveFile: tab.path === selectedFilePath,
      source: 'editor' as const,
    }))
  )
  const commandProblems = buildCommandProblemLocations({ commandResult, selectedFilePath })

  return [...commandProblems, ...languageServiceProblems, ...editorProblems]
    .sort((left, right) => {
      if (left.isActiveFile !== right.isActiveFile) return left.isActiveFile ? -1 : 1

      const severityDelta = severityRank(left.severity) - severityRank(right.severity)
      if (severityDelta) return severityDelta

      if (left.source !== right.source) return left.source === 'command' ? -1 : 1

      return (
        left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column
      )
    })
    .slice(0, MAX_PROBLEM_LOCATIONS)
}
