import * as ts from 'typescript'

import { isEmpty, isPresent } from '@velaros-ai/core'
import type {
  WorkbenchLanguageServiceCompletionItem,
  WorkbenchLanguageServiceRange,
} from '@velaros-ai/core/types'

const MaxCompletionItems = 120
const MaxCompletionDetailResolutions = 16
const CompletionFormatCodeSettings: ts.FormatCodeSettings = {
  convertTabsToSpaces: true,
  tabSize: 2,
  indentSize: 2,
  indentStyle: ts.IndentStyle.Smart,
  newLineCharacter: '\n',
}
const CompletionPreferences: ts.UserPreferences = {
  quotePreference: 'single',
  importModuleSpecifierPreference: 'relative',
  includePackageJsonAutoImports: 'auto',
}

/** 提取光标前的标识符前缀，用于像 VSCode 那样按输入过滤补全项。 */
function completionPrefixAt(content: string, offset: number): string {
  let start = Math.min(Math.max(offset, 0), content.length)
  while (start > 0 && /[A-Za-z0-9_$]/.test(content[start - 1] ?? '')) {
    start -= 1
  }
  return content.slice(start, offset)
}

/**
 * TypeScript 会一次性返回整套(约上千条)补全项且不按输入前缀预过滤——过滤是编辑器的职责。
 * 若在裁剪到上限前不先按前缀过滤，像 `export`/`function`/`return` 这类排在原始列表靠后的
 * 关键字会被直接截掉。这里先按前缀过滤并排序(startsWith 优先，再按 TS 的 sortText)，再裁剪。
 */
function prioritizeCompletionEntries(
  entries: readonly ts.CompletionEntry[],
  prefix: string
): ts.CompletionEntry[] {
  if (!prefix) return entries.slice(0, MaxCompletionItems)

  const loweredPrefix = prefix.toLowerCase()
  const scored = entries
    .map((entry) => {
      const candidate = (entry.filterText ?? entry.name).toLowerCase()
      const startsWith = candidate.startsWith(loweredPrefix)
      const matches = startsWith || candidate.includes(loweredPrefix)
      return { entry, matches, startsWith }
    })
    .filter((scored) => scored.matches)

  if (isEmpty(scored)) return entries.slice(0, MaxCompletionItems)

  scored.sort((left, right) => {
    if (left.startsWith !== right.startsWith) return left.startsWith ? -1 : 1
    const sortDelta = (left.entry.sortText ?? '').localeCompare(right.entry.sortText ?? '')
    if (sortDelta !== 0) return sortDelta
    return left.entry.name.localeCompare(right.entry.name)
  })

  return scored.slice(0, MaxCompletionItems).map((scored) => scored.entry)
}

export function mapTypeScriptCompletionKind(kind: ts.ScriptElementKind): string {
  switch (kind) {
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.localVariableElement:
      return 'variable'
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
      return 'function'
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
    case ts.ScriptElementKind.memberAccessorVariableElement:
      return 'property'
    case ts.ScriptElementKind.constructSignatureElement:
    case ts.ScriptElementKind.callSignatureElement:
    case ts.ScriptElementKind.indexSignatureElement:
      return 'method'
    case ts.ScriptElementKind.classElement:
      return 'class'
    case ts.ScriptElementKind.interfaceElement:
      return 'interface'
    case ts.ScriptElementKind.typeElement:
      return 'type'
    case ts.ScriptElementKind.enumElement:
      return 'enum'
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return 'namespace'
    case ts.ScriptElementKind.keyword:
      return 'keyword'
    case ts.ScriptElementKind.alias:
    case ts.ScriptElementKind.constElement:
      return 'constant'
    case ts.ScriptElementKind.string:
      return 'text'
    default:
      return 'text'
  }
}

function displayPartsToText(
  parts: readonly ts.SymbolDisplayPart[] | undefined
): string | undefined {
  if (!parts?.length) return undefined
  return parts.map((part) => part.text).join('')
}

function rangeFromTextSpan(
  content: string,
  fileName: string,
  textSpan: ts.TextSpan
): Nullable<WorkbenchLanguageServiceRange> {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
  const start = sourceFile.getLineAndCharacterOfPosition(textSpan.start)
  const end = sourceFile.getLineAndCharacterOfPosition(textSpan.start + textSpan.length)

  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  }
}

function buildCompletionDetail(entry: ts.CompletionEntry): string | undefined {
  const source = displayPartsToText(entry.sourceDisplay)
  const modifiers = entry.kindModifiers?.trim()
  if (source && modifiers) return `${source} · ${modifiers}`
  return source ?? modifiers
}

function shouldResolveCompletionDetails(entry: ts.CompletionEntry, resolvedCount: number): boolean {
  if (resolvedCount >= MaxCompletionDetailResolutions) return false
  return Boolean(entry.source || entry.isSnippet)
}

function normalizeCommonJsAutoImport(fileName: string, newText: string): string {
  if (!fileName.toLowerCase().endsWith('.cjs')) return newText

  const lineBreakIndex = newText.indexOf('\n')
  const statement = (lineBreakIndex === -1 ? newText : newText.slice(0, lineBreakIndex)).trim()
  const suffix = lineBreakIndex === -1 ? '' : newText.slice(lineBreakIndex)
  const namedImport = /^import\s+\{\s*([^}]+?)\s*\}\s+from\s+(['"][^'"]+['"]);?$/u.exec(statement)
  if (namedImport) {
    const bindings = (namedImport[1] ?? '')
      .split(',')
      .map((binding) => binding.trim().replace(/\s+as\s+/u, ': '))
      .join(', ')
    return `const { ${bindings} } = require(${namedImport[2]});${suffix}`
  }

  const namespaceImport = /^import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"][^'"]+['"]);?$/u.exec(
    statement
  )
  if (namespaceImport)
    return `const ${namespaceImport[1]} = require(${namespaceImport[2]});${suffix}`

  const defaultImport = /^import\s+([\w$]+)\s+from\s+(['"][^'"]+['"]);?$/u.exec(statement)
  if (defaultImport) return `const ${defaultImport[1]} = require(${defaultImport[2]});${suffix}`

  return newText
}

function collectAdditionalTextEdits(
  details: ts.CompletionEntryDetails,
  files: Map<string, string>
): WorkbenchLanguageServiceCompletionItem['additionalTextEdits'] {
  const edits: NonNullable<WorkbenchLanguageServiceCompletionItem['additionalTextEdits']> = []

  for (const action of details.codeActions ?? []) {
    for (const change of action.changes) {
      const content = files.get(change.fileName) ?? ''
      for (const textChange of change.textChanges) {
        const range = rangeFromTextSpan(content, change.fileName, textChange.span)
        if (!range) continue
        edits.push({
          path: change.fileName,
          range,
          newText: normalizeCommonJsAutoImport(change.fileName, textChange.newText),
        })
      }
    }
  }

  return isEmpty(edits) ? undefined : edits
}

export function buildTypeScriptCompletionItems({
  service,
  fileName,
  offset,
  files,
  toRelativePath,
}: {
  service: ts.LanguageService
  fileName: string
  offset: number
  files: Map<string, string>
  toRelativePath: (absolutePath: string) => Nullable<string>
}): WorkbenchLanguageServiceCompletionItem[] {
  const completions = service.getCompletionsAtPosition(
    fileName,
    offset,
    {
      ...CompletionPreferences,
      includeCompletionsForModuleExports: true,
      includeCompletionsWithInsertText: true,
      includeAutomaticOptionalChainCompletions: true,
      includeCompletionsForImportStatements: true,
      includeCompletionsWithClassMemberSnippets: true,
      includeCompletionsWithObjectLiteralMethodSnippets: true,
      includeCompletionsWithSnippetText: true,
      useLabelDetailsInCompletionEntries: true,
    },
    CompletionFormatCodeSettings
  )

  if (!completions?.entries.length) return []

  const prefix = completionPrefixAt(files.get(fileName) ?? '', offset)
  const prioritizedEntries = prioritizeCompletionEntries(completions.entries, prefix)

  let resolvedCount = 0
  const items: WorkbenchLanguageServiceCompletionItem[] = []

  for (const entry of prioritizedEntries) {
    const insertText = entry.insertText ?? entry.name
    let documentation: string | undefined
    let additionalTextEdits: WorkbenchLanguageServiceCompletionItem['additionalTextEdits']
    const isSnippet = entry.isSnippet

    if (shouldResolveCompletionDetails(entry, resolvedCount)) {
      resolvedCount += 1
      let details: ts.CompletionEntryDetails | undefined
      try {
        details =
          service.getCompletionEntryDetails(
            fileName,
            offset,
            entry.name,
            CompletionFormatCodeSettings,
            entry.source,
            CompletionPreferences,
            entry.data
          ) ?? undefined
      } catch {
        details = undefined
      }

      if (details) {
        if (entry.source) {
          documentation = displayPartsToText(details.documentation)
        }
        additionalTextEdits = collectAdditionalTextEdits(details, files)
          ?.map((edit) => {
            const relativePath = toRelativePath(edit.path)
            if (!relativePath) return null
            return {
              ...edit,
              path: relativePath,
            }
          })
          .filter((edit): edit is NonNullable<typeof edit> => isPresent(edit))
      }
    }

    items.push({
      label: entry.name,
      kind: mapTypeScriptCompletionKind(entry.kind),
      detail: entry.labelDetails?.detail ?? buildCompletionDetail(entry),
      returnType: entry.labelDetails?.description,
      documentation,
      insertText,
      sortText: entry.sortText,
      filterText: entry.filterText,
      isSnippet,
      additionalTextEdits,
    })
  }

  return items
}
