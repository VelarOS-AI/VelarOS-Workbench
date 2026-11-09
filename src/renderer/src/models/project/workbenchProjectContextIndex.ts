import { type WorkbenchDirectoryEntry } from '@shared/contracts/workbench'

import { fileLanguage } from '../shared/workbenchUtils'

export interface WorkbenchOpenFileSnapshot {
  path: string
  content: string
  language: string
}

export interface WorkbenchProjectContextFile {
  path: string
  name: string
  language: string
}

export interface WorkbenchProjectContextSymbol {
  label: string
  path: string
  language: string
  count: number
  kind?: 'declaration' | 'reference'
  line?: number
  column?: number
}

export interface WorkbenchProjectContextIndex {
  files: WorkbenchProjectContextFile[]
  symbols: WorkbenchProjectContextSymbol[]
  loadedDirectoryCount: number
  indexedFileCount: number
}

const SYMBOL_PATTERN = /[A-Za-z_$][\w$]*/g
const DECLARATION_PATTERN =
  /\b(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g
const MAX_CONTEXT_FILES = 800
const MAX_SYMBOLS_PER_FILE = 120
const MAX_CONTEXT_SYMBOLS = 400

function uniqueSortedFiles(files: WorkbenchProjectContextFile[]): WorkbenchProjectContextFile[] {
  const byPath = new Map<string, WorkbenchProjectContextFile>()

  for (const file of files) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file)
    }
  }

  return [...byPath.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_CONTEXT_FILES)
}

function buildFileContextFromTree(
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
): WorkbenchProjectContextFile[] {
  const files: WorkbenchProjectContextFile[] = []

  for (const entries of childrenByPath.values()) {
    for (const entry of entries) {
      if (entry.type !== 'file') {
        continue
      }

      files.push({
        path: entry.path,
        name: entry.name,
        language: fileLanguage(entry.path),
      })
    }
  }

  return uniqueSortedFiles(files)
}

function lineColumnFromOffset(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, offset)
  const line = before.split('\n').length
  const lineStart = before.lastIndexOf('\n') + 1

  return {
    line,
    column: offset - lineStart + 1,
  }
}

function extractFileSymbols(file: WorkbenchOpenFileSnapshot): WorkbenchProjectContextSymbol[] {
  const counts = new Map<
    string,
    {
      count: number
      kind: 'declaration' | 'reference'
      line: number
      column: number
    }
  >()

  const recordSymbol = (label: string, offset: number, kind: 'declaration' | 'reference'): void => {
    if (label.length < 2) return

    const current = counts.get(label)
    if (current) {
      current.count += 1
      if (current.kind === 'reference' && kind === 'declaration') {
        Object.assign(current, {
          kind,
          ...lineColumnFromOffset(file.content, offset),
        })
      }
      return
    }

    counts.set(label, {
      count: 1,
      kind,
      ...lineColumnFromOffset(file.content, offset),
    })
  }

  for (const match of file.content.matchAll(DECLARATION_PATTERN)) {
    const label = match[1]
    if (!label) {
      continue
    }

    const offset = (match.index ?? 0) + match[0].lastIndexOf(label)
    recordSymbol(label, offset, 'declaration')
  }

  for (const match of file.content.matchAll(SYMBOL_PATTERN)) {
    recordSymbol(match[0], match.index ?? 0, 'reference')
  }

  return [...counts.entries()]
    .sort(
      (left, right) =>
        +(right[1].kind === 'declaration') - +(left[1].kind === 'declaration') ||
        right[1].count - left[1].count ||
        left[0].localeCompare(right[0])
    )
    .slice(0, MAX_SYMBOLS_PER_FILE)
    .map(([label, metadata]) => ({
      label,
      path: file.path,
      language: file.language,
      count: metadata.count,
      kind: metadata.kind,
      line: metadata.line,
      column: metadata.column,
    }))
}

function sortContextSymbols(
  symbols: WorkbenchProjectContextSymbol[]
): WorkbenchProjectContextSymbol[] {
  return symbols
    .sort(
      (left, right) =>
        +(right.kind === 'declaration') - +(left.kind === 'declaration') ||
        right.count - left.count ||
        left.label.localeCompare(right.label)
    )
    .slice(0, MAX_CONTEXT_SYMBOLS)
}

export function buildWorkbenchProjectContextIndex({
  childrenByPath,
  openFiles,
  indexedFiles = [],
}: {
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
  openFiles: WorkbenchOpenFileSnapshot[]
  indexedFiles?: WorkbenchOpenFileSnapshot[]
}): WorkbenchProjectContextIndex {
  const fileContexts = [
    ...buildFileContextFromTree(childrenByPath),
    ...indexedFiles.map((file) => ({
      path: file.path,
      name: file.path.split('/').at(-1) ?? file.path,
      language: file.language,
    })),
  ]
  // 打开的文件以当前编辑正文为准：不能让磁盘旧符号或旧计数盖过草稿。
  const textFiles = new Map(indexedFiles.map((file) => [file.path, file]))
  for (const file of openFiles) textFiles.set(file.path, file)

  return {
    files: uniqueSortedFiles(fileContexts),
    symbols: sortContextSymbols([...textFiles.values()].flatMap(extractFileSymbols)),
    loadedDirectoryCount: childrenByPath.size,
    indexedFileCount: indexedFiles.length,
  }
}
