import {
  completeFromList,
  type CompletionResult,
  type CompletionSource,
  ifNotIn,
} from '@codemirror/autocomplete'
import { csharpCompletion } from '@codincod/codemirror-lang-csharp'

import { getWorkbenchPathExtension, WorkbenchCppFileExtensions } from '@shared/workbenchLanguageServices'

import type { WorkbenchProjectContextIndex } from '../project/workbenchProjectContextIndex'

import type { WorkbenchCompletionPresentation } from './workbenchCodeMirrorCompletionPresentation'
import {
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchTypeScriptLanguageService,
} from './workbenchCodeMirrorLanguageService'
import {
  buildLocalWorkbenchEditorSuggestions,
  buildWorkbenchEditorSuggestionRequest,
  shouldAutoOpenWorkbenchEditorSuggestions,
  type WorkbenchEditorSuggestionKind,
} from './workbenchEditorSuggestions'

interface WorkbenchCodeMirrorCompletionResultRequest {
  path: Nullable<string>
  language: string
  content: string
  selectionStart: number
  selectionEnd: number
  explicit: boolean
  projectContextIndex: WorkbenchProjectContextIndex
}

const COMPLETION_VALID_FOR = /^[\w$./@-]*$/
const LANGUAGE_SERVICE_LOCAL_SUGGESTION_LIMIT = 4

const csharpLocalCompletion = ifNotIn(
  [
    'LineComment',
    'BlockComment',
    'DocComment',
    'Directive',
    'CharLiteral',
    'String',
    'VerbatimString',
    'RawString',
    'InterpolatedContent',
    'VerbatimInterpolatedContent',
    'FormatSpec',
  ],
  csharpCompletion
)

const javaLocalCompletion = ifNotIn(
  ['LineComment', 'BlockComment', 'CharacterLiteral', 'StringLiteral', 'TextBlock'],
  completeFromList(
    (
      'abstract assert boolean break byte case catch char class continue default do double else ' +
      'enum extends false final finally float for if implements import instanceof int interface long ' +
      'native new null package permits private protected public record return sealed short static ' +
      'strictfp super switch synchronized this throw throws transient true try var void volatile while yield'
    )
      .split(' ')
      .map((label) => ({ label, type: 'keyword' }))
  )
)

const commonCFamilyKeywords =
  'alignas alignof auto bool break case char const continue default do double else enum extern false float for goto if inline int long nullptr register return short signed sizeof static static_assert struct switch true typedef union unsigned void volatile while'

function cFamilyKeywordCompletion(keywords: string): CompletionSource {
  return ifNotIn(
    ['LineComment', 'BlockComment', 'String', 'RawString', 'Char', 'SystemLibString',
      'comment', 'lineComment', 'blockComment', 'string', 'character', 'meta'],
    completeFromList(keywords.split(' ').map((label) => ({ label, type: 'keyword' })))
  )
}

const cLocalCompletion = cFamilyKeywordCompletion(
  `${commonCFamilyKeywords} restrict typeof typeof_unqual _Alignas _Alignof _Atomic _BitInt _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local thread_local`
)
const cppLocalCompletion = cFamilyKeywordCompletion(
  `${commonCFamilyKeywords} and and_eq asm bitand bitor catch char8_t char16_t char32_t class compl concept const_cast consteval constexpr constinit co_await co_return co_yield decltype delete dynamic_cast explicit export friend import module mutable namespace new noexcept not not_eq operator or or_eq private protected public reinterpret_cast requires static_cast template this thread_local throw try typeid typename using virtual wchar_t xor xor_eq`
)

export function resolveWorkbenchOfflineCodeCompletion(
  path: Nullable<string>
): CompletionSource | null {
  const extension = getWorkbenchPathExtension(path)
  const source =
    extension === 'java'
      ? javaLocalCompletion
      : extension === 'cs' || extension === 'csx'
        ? csharpLocalCompletion
        : extension === 'c'
          ? cLocalCompletion
          : WorkbenchCppFileExtensions.includes(extension)
            ? cppLocalCompletion
            : null
  if (!source) return null
  return (context) => {
    const word = context.matchBefore(/[@$\p{ID_Continue}]+/u)
    if (word && !/^[A-Za-z_]\w*$/u.test(word.text)) return null
    const line = context.state.doc.lineAt(context.pos)
    const beforeWord = context.state.sliceDoc(line.from, word?.from ?? context.pos).trimEnd()
    if (beforeWord.endsWith('.') || beforeWord.endsWith('::') || beforeWord.endsWith('->'))
      return null
    return source(context)
  }
}

function mapSuggestionKind(kind: WorkbenchEditorSuggestionKind): string {
  switch (kind) {
    case 'file':
      return 'file'
    case 'keyword':
      return 'keyword'
    case 'project-symbol':
      return 'variable'
    case 'property':
      return 'property'
    case 'symbol':
      return 'variable'
    default:
      return 'text'
  }
}

export function buildWorkbenchCodeMirrorCompletionResult({
  path,
  language,
  content,
  selectionStart,
  selectionEnd,
  explicit,
  projectContextIndex,
}: WorkbenchCodeMirrorCompletionResultRequest): Nullable<CompletionResult> {
  const request = buildWorkbenchEditorSuggestionRequest({
    path,
    language,
    content,
    selectionStart,
    selectionEnd,
  })
  const usesTsLanguageService = usesWorkbenchTypeScriptLanguageService(path)
  const usesMarkupLanguageService =
    usesWorkbenchBuiltinLanguageService(path) && !usesTsLanguageService
  const suggestions = buildLocalWorkbenchEditorSuggestions(request, {
    projectContext: usesTsLanguageService ? projectContextIndex : undefined,
    limit: usesTsLanguageService ? LANGUAGE_SERVICE_LOCAL_SUGGESTION_LIMIT : usesMarkupLanguageService ? 0 : undefined,
  })

  if (!explicit && !shouldAutoOpenWorkbenchEditorSuggestions(request, suggestions)) return null

  if (!suggestions.length && !usesTsLanguageService && !usesMarkupLanguageService) return null

  if (!suggestions.length && (usesTsLanguageService || usesMarkupLanguageService)) {
    const previousCharacter = request.beforeCursor.at(-1) ?? ''
    if (!explicit && request.prefix.length < 1 && !['.', '/', '@', '<'].includes(previousCharacter)) return null
  }

  return {
    from: request.replaceStart,
    to: request.replaceEnd,
    validFor: COMPLETION_VALID_FOR,
    options: suggestions.map((suggestion): WorkbenchCompletionPresentation => {
      const hasSource = suggestion.kind === 'project-symbol' || suggestion.kind === 'file'
      return {
        label: suggestion.label,
        apply: suggestion.insertText,
        type: mapSuggestionKind(suggestion.kind),
        detail: hasSource ? undefined : suggestion.detail,
        workbenchSource: hasSource ? suggestion.detail : undefined,
        boost: usesTsLanguageService ? -2 : 0,
      }
    }),
  }
}
