import * as ts from 'typescript'

import { isPresent } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceDisplayPart,
  WorkbenchLanguageServiceDisplayPartKind,
  WorkbenchLanguageServiceDocumentHighlight,
  WorkbenchLanguageServiceDocumentSymbol,
  WorkbenchLanguageServiceHoverResult,
  WorkbenchLanguageServiceInlayHint,
  WorkbenchLanguageServiceLocation,
  WorkbenchLanguageServiceOffsetRange,
  WorkbenchLanguageServicePosition,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceSemanticToken,
  WorkbenchLanguageServiceSignatureHelpResult,
  WorkbenchLanguageServiceTextEdit,
} from '@shared/contracts'

const DISPLAY_PART_KINDS: readonly WorkbenchLanguageServiceDisplayPartKind[] = [
  'aliasName',
  'className',
  'enumName',
  'fieldName',
  'interfaceName',
  'keyword',
  'lineBreak',
  'numericLiteral',
  'stringLiteral',
  'localName',
  'methodName',
  'moduleName',
  'operator',
  'parameterName',
  'propertyName',
  'punctuation',
  'space',
  'text',
  'typeParameterName',
  'enumMemberName',
  'functionName',
  'regularExpressionLiteral',
  'link',
  'linkName',
  'linkText',
]
const DISPLAY_PART_KIND_SET = new Set<string>(DISPLAY_PART_KINDS)
const MAX_WORKBENCH_INFERRED_TYPE_HINT_LENGTH = 56
const MAX_WORKBENCH_INFERRED_TYPE_GENERIC_DEPTH = 2

const TYPESCRIPT_SEMANTIC_TOKEN_TYPES = [
  'class',
  'enum',
  'interface',
  'namespace',
  'typeParameter',
  'type',
  'parameter',
  'variable',
  'enumMember',
  'property',
  'function',
  'method',
] as const

const TYPESCRIPT_SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'static',
  'async',
  'readonly',
  'defaultLibrary',
  'local',
] as const

export function shouldDisplayWorkbenchInferredTypeHint(text: string): boolean {
  const inferredType = text.replace(/^:\s*/u, '').trim()
  if (!inferredType || inferredType.length > MAX_WORKBENCH_INFERRED_TYPE_HINT_LENGTH) return false
  if (/[\r\n{}();:&?]/u.test(inferredType) || /=>/u.test(inferredType)) return false
  if (/\b(?:extends|import|infer|keyof|typeof)\b/u.test(inferredType)) return false
  if (/\[[^\]]+\]/u.test(inferredType)) return false
  if (!/^[\p{L}\p{N}_$.'"<>\u005B\u005D,|\s-]+$/u.test(inferredType)) return false

  let genericDepth = 0
  let maxGenericDepth = 0
  let arrayDepth = 0
  for (const character of inferredType) {
    if (character === '<') {
      genericDepth += 1
      maxGenericDepth = Math.max(maxGenericDepth, genericDepth)
    } else if (character === '>') {
      genericDepth -= 1
      if (genericDepth < 0) return false
    } else if (character === '[') {
      arrayDepth += 1
    } else if (character === ']') {
      arrayDepth -= 1
      if (arrayDepth < 0) return false
    }
  }

  if (genericDepth !== 0 || arrayDepth !== 0) return false
  if (maxGenericDepth > MAX_WORKBENCH_INFERRED_TYPE_GENERIC_DEPTH) return false
  if (inferredType.split('|').length > 3) return false

  return true
}

export function isTypeScriptDeprecatedDiagnostic(
  diagnostic: Pick<ts.Diagnostic, 'reportsDeprecated'>
): boolean {
  return isPresent(diagnostic.reportsDeprecated)
}

function displayPartsToText(parts: readonly ts.SymbolDisplayPart[] | undefined): string {
  return parts?.map((part) => part.text).join('') ?? ''
}

function mapDisplayParts(
  parts: readonly ts.SymbolDisplayPart[] | undefined
): readonly WorkbenchLanguageServiceDisplayPart[] {
  return (
    parts?.map((part) => ({
      text: part.text,
      kind: DISPLAY_PART_KIND_SET.has(part.kind)
        ? (part.kind as WorkbenchLanguageServiceDisplayPartKind)
        : 'text',
    })) ?? []
  )
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

function offsetFromPosition(content: string, position: WorkbenchLanguageServicePosition): number {
  if (typeof position.offset === 'number')
    return Math.min(Math.max(0, position.offset), content.length)

  const lines = content.split('\n')
  const lineIndex = Math.min(Math.max(0, position.line - 1), Math.max(0, lines.length - 1))
  const lineOffset = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0)
  return Math.min(lineOffset + Math.max(0, position.column - 1), content.length)
}

function isTypeScriptKeywordAtOffset(content: string, offset: number): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, content)

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const tokenStart = scanner.getTokenPos()
    const tokenEnd = scanner.getTextPos()
    if (offset < tokenStart) return false
    if (offset >= tokenEnd) continue

    return token >= ts.SyntaxKind.FirstKeyword && token <= ts.SyntaxKind.LastKeyword
  }

  return false
}

function locationFromFileSpan(
  projectRoot: string,
  toRelativePath: (absolutePath: string) => Nullable<string>,
  fileName: string,
  textSpan: ts.TextSpan,
  content: string
): Nullable<WorkbenchLanguageServiceLocation> {
  const relativePath = toRelativePath(fileName)
  const range = rangeFromTextSpan(content, fileName, textSpan)
  if (!relativePath || !range) return null

  return {
    path: relativePath,
    line: range.startLine,
    column: range.startColumn,
    range,
  }
}

function mapNavigationBarKind(
  kind: ts.ScriptElementKind
): WorkbenchLanguageServiceDocumentSymbol['kind'] {
  switch (kind) {
    case ts.ScriptElementKind.classElement:
      return 'class'
    case ts.ScriptElementKind.interfaceElement:
      return 'interface'
    case ts.ScriptElementKind.enumElement:
      return 'enum'
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.functionElement:
      return 'function'
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.variableElement:
      return 'variable'
    case ts.ScriptElementKind.typeElement:
      return 'type'
    case ts.ScriptElementKind.constElement:
      return 'constant'
    default:
      return 'symbol'
  }
}

function flattenNavigationBarItems(
  items: readonly ts.NavigationBarItem[],
  content: string,
  fileName: string,
  depth: number,
  bucket: WorkbenchLanguageServiceDocumentSymbol[]
): void {
  for (const item of items) {
    const span = item.spans[0]
    if (span) {
      const range = rangeFromTextSpan(content, fileName, span)
      if (range) {
        bucket.push({
          name: item.text,
          kind: mapNavigationBarKind(item.kind),
          depth,
          line: range.startLine,
          column: range.startColumn,
          range,
        })
      }
    }

    if (item.childItems?.length) {
      flattenNavigationBarItems(item.childItems, content, fileName, depth + 1, bucket)
    }
  }
}

export function buildTypeScriptHoverResult({
  service,
  fileName,
  content,
  position,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
  position: WorkbenchLanguageServicePosition
}): Nullable<WorkbenchLanguageServiceHoverResult> {
  const offset = offsetFromPosition(content, position)
  // TypeScript 会把 `function` 关键字的 Quick Info 关联到后面的函数声明，
  // 因此必须按光标所在的真实语法 token 过滤，不能只看 Quick Info 的 kind。
  if (isTypeScriptKeywordAtOffset(content, offset)) return null

  const quickInfo = service.getQuickInfoAtPosition(fileName, offset)
  if (!quickInfo) return null

  const displayText = displayPartsToText(quickInfo.displayParts)
  const documentation = displayPartsToText(quickInfo.documentation)
  if (!displayText && !documentation) return null

  const displayParts = mapDisplayParts(quickInfo.displayParts)
  const documentationParts = mapDisplayParts(quickInfo.documentation)

  return {
    displayText,
    displayParts: displayParts.length > 0 ? displayParts : undefined,
    documentation: documentation || undefined,
    documentationParts: documentationParts.length > 0 ? documentationParts : undefined,
    tags: quickInfo.tags?.map((tag) => displayPartsToText(tag.text)) ?? [],
  }
}

/**
 * Decodes TypeScript's 2020 semantic-classification format into the same
 * language-neutral token contract used by LSP-backed languages.
 */
export function buildTypeScriptSemanticTokens({
  service,
  fileName,
  content,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
}): WorkbenchLanguageServiceSemanticToken[] {
  const encoded = service.getEncodedSemanticClassifications(
    fileName,
    { start: 0, length: content.length },
    ts.SemanticClassificationFormat.TwentyTwenty
  ).spans
  if (encoded.length % 3 !== 0) return []

  const tokens: WorkbenchLanguageServiceSemanticToken[] = []
  for (let index = 0; index < encoded.length && tokens.length < 10_000; index += 3) {
    const start = encoded[index]!
    const length = encoded[index + 1]!
    const classification = encoded[index + 2]!
    const typeIndex = (classification >> 8) - 1
    const type = TYPESCRIPT_SEMANTIC_TOKEN_TYPES[typeIndex]
    if (!type || start < 0 || length <= 0 || start + length > content.length) continue
    const range = rangeFromTextSpan(content, fileName, { start, length })
    if (!range) continue
    const modifierBits = classification & 0xff
    tokens.push({
      range,
      type,
      modifiers: TYPESCRIPT_SEMANTIC_TOKEN_MODIFIERS.filter(
        (_modifier, modifierIndex) => (modifierBits & (1 << modifierIndex)) !== 0
      ),
    })
  }
  return tokens
}

export function buildTypeScriptReferences({
  service,
  fileName,
  content,
  position,
  files,
  toRelativePath,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
  position: WorkbenchLanguageServicePosition
  files: Map<string, string>
  toRelativePath: (absolutePath: string) => Nullable<string>
}): WorkbenchLanguageServiceLocation[] {
  const offset = offsetFromPosition(content, position)
  const references = service.getReferencesAtPosition(fileName, offset) ?? []

  return references
    .map((reference) =>
      locationFromFileSpan(
        '',
        toRelativePath,
        reference.fileName,
        reference.textSpan,
        files.get(reference.fileName) ?? content
      )
    )
    .filter((location): location is WorkbenchLanguageServiceLocation => location != null)
}

export function buildTypeScriptSignatureHelp({
  service,
  fileName,
  content,
  position,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
  position: WorkbenchLanguageServicePosition
}): Nullable<WorkbenchLanguageServiceSignatureHelpResult> {
  const offset = offsetFromPosition(content, position)
  const help = service.getSignatureHelpItems(fileName, offset, {
    triggerReason: { kind: 'invoked' },
  })
  if (!help?.items.length) return null

  return {
    activeSignature: help.selectedItemIndex,
    activeParameter: help.argumentIndex,
    signatures: help.items.map((item) => ({
      label:
        displayPartsToText(item.prefixDisplayParts) + displayPartsToText(item.suffixDisplayParts),
      documentation: displayPartsToText(item.documentation) || undefined,
      parameters: item.parameters.map((parameter) => ({
        label: displayPartsToText(parameter.displayParts),
        documentation: displayPartsToText(parameter.documentation) || undefined,
      })),
    })),
  }
}

export function buildTypeScriptFormatEdits({
  service,
  fileName,
  content,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
}): WorkbenchLanguageServiceTextEdit[] {
  const formatSettings: ts.FormatCodeSettings = {
    convertTabsToSpaces: true,
    tabSize: 2,
    indentSize: 2,
    indentStyle: ts.IndentStyle.Smart,
    newLineCharacter: '\n',
  }
  const edits = service.getFormattingEditsForDocument(fileName, formatSettings)

  return edits
    .map((edit) => {
      const range = rangeFromTextSpan(content, fileName, edit.span)
      if (!range) return null
      return {
        range,
        newText: edit.newText,
      }
    })
    .filter((edit): edit is WorkbenchLanguageServiceTextEdit => edit != null)
}

export function buildTypeScriptDocumentSymbols({
  service,
  fileName,
  content,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
}): WorkbenchLanguageServiceDocumentSymbol[] {
  const items = service.getNavigationBarItems(fileName) ?? []
  const symbols: WorkbenchLanguageServiceDocumentSymbol[] = []
  flattenNavigationBarItems(items, content, fileName, 0, symbols)
  return symbols
}

export function buildTypeScriptDocumentHighlights({
  service,
  fileName,
  content,
  position,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
  position: WorkbenchLanguageServicePosition
}): WorkbenchLanguageServiceDocumentHighlight[] {
  const offset = offsetFromPosition(content, position)
  const highlights =
    service.getDocumentHighlights(fileName, offset, [
      ts.HighlightSpanKind.none,
      ts.HighlightSpanKind.definition,
      ts.HighlightSpanKind.reference,
      ts.HighlightSpanKind.writtenReference,
    ]) ?? []

  const fileHighlights =
    highlights.find((entry) => entry.fileName === fileName)?.highlightSpans ?? []

  return fileHighlights
    .map((highlight) => {
      const range = rangeFromTextSpan(content, fileName, highlight.textSpan)
      if (!range) return null
      return {
        range,
        kind: highlight.kind === ts.HighlightSpanKind.writtenReference ? 'write' : 'read',
      }
    })
    .filter(
      (highlight): highlight is WorkbenchLanguageServiceDocumentHighlight => highlight != null
    )
}

export function buildTypeScriptInlayHints({
  service,
  fileName,
  content,
  ranges,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
  ranges: readonly WorkbenchLanguageServiceOffsetRange[]
}): WorkbenchLanguageServiceInlayHint[] {
  const preferences = {
    includeInlayFunctionParameterTypeHints: true,
    includeInlayVariableTypeHints: true,
    includeInlayVariableTypeHintsWhenTypeMatchesName: true,
    includeInlayPropertyDeclarationTypeHints: true,
    includeInlayFunctionLikeReturnTypeHints: true,
  }
  const hints = ranges
    .slice(0, 8)
    .map((range) => {
      const start = Math.min(Math.max(0, range.from), content.length)
      const end = Math.min(Math.max(start, range.to), content.length)
      return { start, length: end - start }
    })
    .filter((span) => span.length > 0)
    .flatMap((span) => service.provideInlayHints(fileName, span, preferences) ?? [])
  const sourceFile =
    service.getProgram?.()?.getSourceFile(fileName) ??
    ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
  const seen = new Set<string>()

  return hints
    .filter((hint) => hint.kind === ts.InlayHintKind.Type)
    .flatMap((hint) => {
      const text = hint.text || hint.displayParts?.map((part) => part.text).join('') || ''
      const key = `${hint.position}:${text}`
      if (seen.has(key)) return []
      seen.add(key)
      const location = sourceFile.getLineAndCharacterOfPosition(hint.position)

      return [
        {
          position: {
            line: location.line + 1,
            column: location.character + 1,
            offset: hint.position,
          },
          text,
          kind: 'type' as const,
          whitespaceBefore: hint.whitespaceBefore,
          whitespaceAfter: hint.whitespaceAfter,
        },
      ]
    })
    .filter((hint) => shouldDisplayWorkbenchInferredTypeHint(hint.text))
}
