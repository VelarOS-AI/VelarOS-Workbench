import * as ts from 'typescript'

import type {
  WorkbenchLanguageServiceCompletionItem,
  WorkbenchLanguageServiceCompletionResolveData,
  WorkbenchLanguageServiceCompletionTextEdit,
  WorkbenchLanguageServiceEditFormat,
} from '@shared/contracts'

import {
  buildWorkbenchTypeScriptFormatCodeSettings,
  rangeFromTextSpanInContent,
} from './TypeScriptLanguageFeatures'

/**
 * 一次交给编辑器的补全项上限。TypeScript 不按已输入的前缀预先过滤（过滤与排序是编辑器的事），全局补全连同
 * 自动导入通常一两千项；超过上限的截掉并标记「不完整」，编辑器继续输入时重新请求，不会永久丢项。
 */
const MaxCompletionItems = 5_000
/** 语言服务替用户写 import 时的偏好：补全的自动导入、快速修复、重构共用一份，写出来的样子才一致。 */
export const WorkbenchTypeScriptUserPreferences: ts.UserPreferences = {
  quotePreference: 'single',
  importModuleSpecifierPreference: 'relative',
  includePackageJsonAutoImports: 'auto',
}
const CompletionPreferences = WorkbenchTypeScriptUserPreferences

export function mapTypeScriptCompletionKind(kind: ts.ScriptElementKind): string {
  switch (kind) {
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.localVariableElement:
    case ts.ScriptElementKind.parameterElement:
      return 'variable'
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
    case ts.ScriptElementKind.memberAccessorVariableElement:
      return 'property'
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.constructSignatureElement:
    case ts.ScriptElementKind.callSignatureElement:
    case ts.ScriptElementKind.indexSignatureElement:
      return 'method'
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
      return 'function'
    case ts.ScriptElementKind.classElement:
    case ts.ScriptElementKind.localClassElement:
      return 'class'
    case ts.ScriptElementKind.interfaceElement:
      return 'interface'
    case ts.ScriptElementKind.typeElement:
    case ts.ScriptElementKind.typeParameterElement:
      return 'type'
    case ts.ScriptElementKind.enumElement:
      return 'enum'
    case ts.ScriptElementKind.enumMemberElement:
      return 'constant'
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return 'namespace'
    case ts.ScriptElementKind.keyword:
      return 'keyword'
    case ts.ScriptElementKind.letElement:
      return 'variable'
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

function buildCompletionDetail(entry: ts.CompletionEntry): string | undefined {
  const source = displayPartsToText(entry.sourceDisplay)
  const modifiers = entry.kindModifiers?.trim()
  if (source && modifiers) return `${source} · ${modifiers}`
  return source ?? modifiers
}

export function normalizeCommonJsAutoImport(fileName: string, newText: string): string {
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

/** 自动导入的改动只落在当前文件（导入语句）；别的文件的改动不在补全里做。 */
function collectAdditionalTextEdits(
  details: ts.CompletionEntryDetails,
  fileName: string,
  content: string,
  relativePath: string
): WorkbenchLanguageServiceCompletionTextEdit[] {
  const edits: WorkbenchLanguageServiceCompletionTextEdit[] = []

  for (const action of details.codeActions ?? []) {
    for (const change of action.changes) {
      if (change.fileName !== fileName) continue
      for (const textChange of change.textChanges) {
        const range = rangeFromTextSpanInContent(content, change.fileName, textChange.span)
        if (!range) continue
        edits.push({
          path: relativePath,
          range,
          newText: normalizeCommonJsAutoImport(change.fileName, textChange.newText),
        })
      }
    }
  }

  return edits
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildTypeScriptCompletionItems({
  service,
  fileName,
  offset,
  content,
  format,
}: {
  service: ts.LanguageService
  fileName: string
  offset: number
  content: string
  /** 编辑器里这个文件的缩进：补全里带的整段代码（补全类成员、对象方法）按它排。 */
  format?: WorkbenchLanguageServiceEditFormat
}): { items: WorkbenchLanguageServiceCompletionItem[]; isIncomplete: boolean } {
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
    buildWorkbenchTypeScriptFormatCodeSettings(format)
  )

  if (!completions?.entries.length) return { items: [], isIncomplete: false }

  const entries = completions.entries.slice(0, MaxCompletionItems)
  const items = entries.map((entry): WorkbenchLanguageServiceCompletionItem => {
    const range = entry.replacementSpan
      ? rangeFromTextSpanInContent(content, fileName, entry.replacementSpan)
      : null
    return {
      label: entry.name,
      kind: mapTypeScriptCompletionKind(entry.kind),
      detail: entry.labelDetails?.detail ?? buildCompletionDetail(entry),
      returnType: entry.labelDetails?.description,
      insertText: entry.insertText ?? entry.name,
      range: range ?? undefined,
      // TypeScript 的 sortText 只分优先级（本地、全局、自动导入……），同级再按名字排；空格排在数字、字母之前。
      sortText: `${entry.sortText} ${entry.name}`,
      filterText: entry.filterText,
      isSnippet: entry.isSnippet,
      // 自动导入的 import 语句要在接受时再算（一次补全可能有上千个候选，不能每项都先算好）。
      resolve: entry.hasAction
        ? {
            name: entry.name,
            source: entry.source,
            data: isJsonRecord(entry.data) ? { ...entry.data } : undefined,
          }
        : undefined,
    }
  })

  return {
    items,
    isIncomplete: completions.entries.length > entries.length || !!completions.isIncomplete,
  }
}

/** 接受（或选中）一个自动导入候选时，算出要加的 import 语句与说明。 */
export function resolveTypeScriptCompletionItem({
  service,
  fileName,
  offset,
  content,
  relativePath,
  item,
  format,
}: {
  service: ts.LanguageService
  fileName: string
  offset: number
  content: string
  relativePath: string
  item: WorkbenchLanguageServiceCompletionResolveData
  format?: WorkbenchLanguageServiceEditFormat
}): { additionalTextEdits: WorkbenchLanguageServiceCompletionTextEdit[]; documentation?: string } {
  const details = service.getCompletionEntryDetails(
    fileName,
    offset,
    item.name,
    buildWorkbenchTypeScriptFormatCodeSettings(format),
    item.source,
    CompletionPreferences,
    item.data as ts.CompletionEntryData | undefined
  )
  if (!details) return { additionalTextEdits: [] }

  return {
    additionalTextEdits: collectAdditionalTextEdits(details, fileName, content, relativePath),
    documentation: displayPartsToText(details.documentation),
  }
}
