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

interface TypeScriptDefaultLibraryApiDocumentation {
  documentation: string
  tags?: readonly string[]
}

const TYPESCRIPT_DEFAULT_LIBRARY_API_DOCUMENTATION: Readonly<
  Record<string, TypeScriptDefaultLibraryApiDocumentation>
> = {
  'Array.isArray': {
    documentation: 'Determines whether the supplied value is an Array.',
    tags: [
      '@param arg The value to test.',
      '@returns true when arg is an Array; otherwise false.',
    ],
  },
  'Array.from': {
    documentation: 'Creates a new Array from an iterable or array-like value.',
  },
  'Array.of': {
    documentation: 'Creates a new Array from the supplied arguments.',
  },
  'Date.now': {
    documentation: 'Returns the current time as milliseconds elapsed since 1 January 1970 UTC.',
  },
  'JSON.parse': {
    documentation: 'Parses JSON text and returns the corresponding JavaScript value or object.',
  },
  'JSON.stringify': {
    documentation: 'Converts a JavaScript value to JSON text.',
  },
  'Number.isFinite': {
    documentation: 'Determines whether a value is a finite number without coercing it.',
  },
  'Number.isInteger': {
    documentation: 'Determines whether a value is an integer.',
  },
  'Number.isNaN': {
    documentation: 'Determines whether a value is the numeric value NaN without coercing it.',
  },
  'Number.isSafeInteger': {
    documentation: 'Determines whether a value is an integer that can be represented exactly.',
  },
  'Object.assign': {
    documentation: 'Copies enumerable own properties from source objects to a target object.',
  },
  'Object.create': {
    documentation: 'Creates an object with the specified prototype and optional properties.',
  },
  'Object.entries': {
    documentation: 'Returns the enumerable own string-keyed property pairs of an object.',
  },
  'Object.fromEntries': {
    documentation: 'Creates an object from an iterable of key-value pairs.',
  },
  'Object.hasOwn': {
    documentation: 'Determines whether an object has the specified property as its own property.',
  },
  'Object.keys': {
    documentation: 'Returns the enumerable own string-keyed property names of an object.',
  },
  'Object.values': {
    documentation: 'Returns the enumerable own string-keyed property values of an object.',
  },
  'Promise.all': {
    documentation: 'Waits for all input promises and returns their resolved values in input order.',
  },
  'Promise.allSettled': {
    documentation: 'Waits for all input promises and reports every fulfillment or rejection.',
  },
  'Promise.race': {
    documentation: 'Settles with the first input promise that settles.',
  },
  'Promise.resolve': {
    documentation: 'Returns a Promise resolved with the supplied value.',
  },
}

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

const TYPESCRIPT_PRIMITIVE_KEYWORD_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.IntrinsicKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.VoidKeyword,
])
const TYPESCRIPT_GLOBAL_KEYWORD_VALUE_NAMES = new Set(['Infinity', 'NaN', 'undefined'])
const TYPESCRIPT_GLOBAL_BUILTIN_VALUE_NAMES = new Set(['globalThis'])
const TYPESCRIPT_DEFAULT_LIBRARY_FILE_PATTERN = /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/u

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

function formatTypeScriptJSDocTag(tag: ts.JSDocTagInfo): string {
  const text = displayPartsToText(tag.text).trim()
  return text ? `@${tag.name} ${text}` : `@${tag.name}`
}

function qualifiedJavaScriptNameAtOffset(content: string, offset: number): Nullable<string> {
  let from = Math.min(Math.max(0, offset), content.length)
  let to = from
  while (from > 0 && /[\w$]/u.test(content[from - 1] ?? '')) from -= 1
  while (to < content.length && /[\w$]/u.test(content[to] ?? '')) to += 1
  const property = content.slice(from, to)
  const owner = content.slice(0, from).match(/([A-Za-z_$][\w$]*)\s*\.\s*$/u)?.[1]
  return owner && property ? `${owner}.${property}` : null
}

function defaultLibraryApiDocumentationAtOffset(
  service: ts.LanguageService,
  fileName: string,
  content: string,
  offset: number
): Nullable<TypeScriptDefaultLibraryApiDocumentation> {
  const qualifiedName = qualifiedJavaScriptNameAtOffset(content, offset)
  const documentation = qualifiedName
    ? TYPESCRIPT_DEFAULT_LIBRARY_API_DOCUMENTATION[qualifiedName]
    : undefined
  if (!documentation) return null

  const definitions = service.getDefinitionAtPosition(fileName, offset) ?? []
  return definitions.some((definition) =>
    /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/u.test(definition.fileName)
  ) ? documentation : null
}

function rangeFromTextSpan(
  content: string,
  fileName: string,
  textSpan: ts.TextSpan
): Nullable<WorkbenchLanguageServiceRange> {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
  return rangeFromSourceFileSpan(sourceFile, textSpan)
}

function rangeFromSourceFileSpan(
  sourceFile: ts.SourceFile,
  textSpan: ts.TextSpan
): Nullable<WorkbenchLanguageServiceRange> {
  if (
    textSpan.start < 0
    || textSpan.length < 0
    || textSpan.start + textSpan.length > sourceFile.text.length
  ) return null
  const start = sourceFile.getLineAndCharacterOfPosition(textSpan.start)
  const end = sourceFile.getLineAndCharacterOfPosition(textSpan.start + textSpan.length)

  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  }
}

function isDefaultLibraryFileName(fileName: string): boolean {
  return TYPESCRIPT_DEFAULT_LIBRARY_FILE_PATTERN.test(fileName)
}

function isIdentifierPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isQualifiedName(parent) && parent.right === node)
  ) return true
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false
  return (parent as ts.NamedDeclaration).name === node
}

function unshadowedDefaultLibrarySymbol(
  checker: ts.TypeChecker,
  node: ts.Identifier
): Nullable<ts.Symbol> {
  if (isIdentifierPropertyName(node)) return null

  const shorthand = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : undefined
  const locationSymbol = shorthand ?? checker.getSymbolAtLocation(node)
  if (!locationSymbol) return null
  const symbol = (locationSymbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(locationSymbol)
    : locationSymbol
  if (symbol.getName() !== node.text) return null

  const declarations = symbol.declarations ?? []
  if (declarations.length === 0)
    return (symbol.flags & ts.SymbolFlags.Transient) !== 0 ? symbol : null
  return declarations.every((declaration) =>
    isDefaultLibraryFileName(declaration.getSourceFile().fileName)
  ) ? symbol : null
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
  const compilerDocumentation = displayPartsToText(quickInfo.documentation)
  const fallbackDocumentation = compilerDocumentation
    ? null
    : defaultLibraryApiDocumentationAtOffset(service, fileName, content, offset)
  const documentation = compilerDocumentation || fallbackDocumentation?.documentation || ''
  if (!displayText && !documentation) return null

  const displayParts = mapDisplayParts(quickInfo.displayParts)
  const documentationParts = mapDisplayParts(quickInfo.documentation)

  return {
    displayText,
    displayParts: displayParts.length > 0 ? displayParts : undefined,
    documentation: documentation || undefined,
    documentationParts: documentationParts.length > 0 ? documentationParts : undefined,
    tags: quickInfo.tags?.map(formatTypeScriptJSDocTag)
      ?? [...(fallbackDocumentation?.tags ?? [])],
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

  const program = service.getProgram?.()
  const programSourceFile = program?.getSourceFile(fileName)
  const sourceFile = programSourceFile?.text === content
    ? programSourceFile
    : ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
  const checker = programSourceFile === sourceFile ? program?.getTypeChecker() : undefined
  const tokens = new Map<
    string,
    { start: number; length: number; token: WorkbenchLanguageServiceSemanticToken }
  >()
  const upsertToken = (
    start: number,
    length: number,
    type: string,
    modifiers: string[],
    override = false
  ): void => {
    const key = `${start}:${length}`
    if ((!override && tokens.has(key)) || (!tokens.has(key) && tokens.size >= 10_000)) return
    const range = rangeFromSourceFileSpan(sourceFile, { start, length })
    if (!range) return
    tokens.set(key, { start, length, token: { range, type, modifiers } })
  }

  for (let index = 0; index < encoded.length; index += 3) {
    const start = encoded[index]!
    const length = encoded[index + 1]!
    const classification = encoded[index + 2]!
    const typeIndex = (classification >> 8) - 1
    const type = TYPESCRIPT_SEMANTIC_TOKEN_TYPES[typeIndex]
    if (!type || start < 0 || length <= 0 || start + length > content.length) continue
    const modifierBits = classification & 0xff
    upsertToken(
      start,
      length,
      type,
      TYPESCRIPT_SEMANTIC_TOKEN_MODIFIERS.filter(
        (_modifier, modifierIndex) => (modifierBits & (1 << modifierIndex)) !== 0
      ),
    )
  }

  const visit = (node: ts.Node): void => {
    if (
      TYPESCRIPT_PRIMITIVE_KEYWORD_KINDS.has(node.kind)
      && (node.flags & ts.NodeFlags.JSDoc) === 0
    ) {
      upsertToken(node.getStart(sourceFile), node.getWidth(sourceFile), 'keyword', [], true)
    } else if (
      checker
      && ts.isIdentifier(node)
      && (
        TYPESCRIPT_GLOBAL_KEYWORD_VALUE_NAMES.has(node.text)
        || TYPESCRIPT_GLOBAL_BUILTIN_VALUE_NAMES.has(node.text)
      )
      && unshadowedDefaultLibrarySymbol(checker, node)
    ) {
      if (TYPESCRIPT_GLOBAL_KEYWORD_VALUE_NAMES.has(node.text)) {
        upsertToken(node.getStart(sourceFile), node.getWidth(sourceFile), 'keyword', [], true)
      } else {
        upsertToken(
          node.getStart(sourceFile),
          node.getWidth(sourceFile),
          'variable',
          ['defaultLibrary'],
          true
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return [...tokens.values()]
    .sort((left, right) => left.start - right.start || left.length - right.length)
    .map(({ token }) => token)
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

/**
 * 内置 TS 格式化与补全插入代码共用的排版规则：以 TypeScript 自己的默认值为底（逗号后、二元运算符两侧、
 * 控制语句关键字后留空格），只把缩进改成两格。只给缩进那几项时，TypeScript 把没给的空格规则一律当成关，
 * 格式化出来是 `left+right`、`if(right===0)`。
 */
export const WorkbenchTypeScriptFormatCodeSettings: Readonly<ts.FormatCodeSettings> = Object.freeze({
  ...ts.getDefaultFormatCodeSettings('\n'),
  tabSize: 2,
  indentSize: 2,
})

export function buildTypeScriptFormatEdits({
  service,
  fileName,
  content,
}: {
  service: ts.LanguageService
  fileName: string
  content: string
}): WorkbenchLanguageServiceTextEdit[] {
  const edits = service.getFormattingEditsForDocument(fileName, WorkbenchTypeScriptFormatCodeSettings)

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
