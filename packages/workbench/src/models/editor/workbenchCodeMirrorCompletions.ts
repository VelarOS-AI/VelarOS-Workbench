import type { CompletionResult } from '@codemirror/autocomplete'

import type { WorkbenchProjectContextIndex } from '../project/workbenchProjectContextIndex'

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

function mapSuggestionKind(kind: WorkbenchEditorSuggestionKind): string {
  switch (kind) {
    case 'file':
      return 'text'
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
    options: suggestions.map((suggestion) => ({
      label: suggestion.label,
      apply: suggestion.insertText,
      type: mapSuggestionKind(suggestion.kind),
      detail: suggestion.detail,
      boost: usesTsLanguageService ? -2 : 0,
    })),
  }
}
