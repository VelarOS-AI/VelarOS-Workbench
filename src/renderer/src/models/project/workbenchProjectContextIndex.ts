import { Text } from '@codemirror/state'

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
const fileSymbolCache = new WeakMap<
  WorkbenchOpenFileSnapshot,
  {
    content: string
    path: string
    language: string
    symbols: WorkbenchProjectContextSymbol[]
  }
>()

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

function extractFileSymbols(file: WorkbenchOpenFileSnapshot): WorkbenchProjectContextSymbol[] {
  const cached = fileSymbolCache.get(file)
  if (
    cached &&
    cached.content === file.content &&
    cached.path === file.path &&
    cached.language === file.language
  )
    return cached.symbols

  const counts = new Map<
    string,
    {
      count: number
      kind: 'declaration' | 'reference'
      offset: number
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
          offset,
        })
      }
      return
    }

    counts.set(label, {
      count: 1,
      kind,
      offset,
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

  // Resolve coordinates only for the retained symbols, using one shared line
  // index instead of splitting every prefix of the document on each keystroke.
  const doc = Text.of(file.content.split('\n'))
  const symbols = [...counts.entries()]
    .sort(
      (left, right) =>
        +(right[1].kind === 'declaration') - +(left[1].kind === 'declaration') ||
        right[1].count - left[1].count ||
        left[0].localeCompare(right[0])
    )
    .slice(0, MAX_SYMBOLS_PER_FILE)
    .map(([label, metadata]) => {
      const line = doc.lineAt(metadata.offset)
      return {
        label,
        path: file.path,
        language: file.language,
        count: metadata.count,
        kind: metadata.kind,
        line: line.number,
        column: metadata.offset - line.from + 1,
      }
    })
  fileSymbolCache.set(file, {
    content: file.content,
    path: file.path,
    language: file.language,
    symbols,
  })
  return symbols
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

export function buildWorkbenchProjectContextFiles(
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>,
  indexedFiles: readonly WorkbenchOpenFileSnapshot[]
): WorkbenchProjectContextFile[] {
  const fileContexts = [
    ...buildFileContextFromTree(childrenByPath),
    ...indexedFiles.map((file) => ({
      path: file.path,
      name: file.path.split('/').at(-1) ?? file.path,
      language: file.language,
    })),
  ]
  return uniqueSortedFiles(fileContexts)
}

export function buildWorkbenchProjectContextIndex({
  childrenByPath,
  openFiles,
  indexedFiles = [],
  files = buildWorkbenchProjectContextFiles(childrenByPath, indexedFiles),
}: {
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
  openFiles: WorkbenchOpenFileSnapshot[]
  indexedFiles?: WorkbenchOpenFileSnapshot[]
  files?: WorkbenchProjectContextFile[]
}): WorkbenchProjectContextIndex {
  let symbols: WorkbenchProjectContextSymbol[] | undefined
  return {
    files,
    get symbols() {
      if (symbols) return symbols
      // 补全或导航需要符号时才读取草稿，按键渲染路径只更新文件快照。
      const textFiles = new Map(indexedFiles.map((file) => [file.path, file]))
      for (const file of openFiles) textFiles.set(file.path, file)
      symbols = sortContextSymbols([...textFiles.values()].flatMap(extractFileSymbols))
      return symbols
    },
    loadedDirectoryCount: childrenByPath.size,
    indexedFileCount: indexedFiles.length,
  }
}
