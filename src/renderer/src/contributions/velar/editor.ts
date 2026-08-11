import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import type { WorkbenchEditorLanguageContribution } from '@renderer/language/workbenchEditorLanguageContributions'

interface VelarStreamState {
  stringQuote: string | null
  rawString: boolean
  layoutString: boolean
  layoutIndent: number
  indentUnit: number
  lineIndent: number
  nextIndent: number
}

export const VELAR_EDITOR_KEYWORDS = [
  'abstract',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'catch',
  'case',
  'class',
  'const',
  'continue',
  'def',
  'else',
  'enum',
  'export',
  'extends',
  'extern',
  'false',
  'finally',
  'for',
  'from',
  'if',
  'import',
  'in',
  'is',
  'js',
  'let',
  'match',
  'module',
  'not',
  'null',
  'or',
  'override',
  'pass',
  'private',
  'return',
  'static',
  'super',
  'throw',
  'true',
  'try',
  'type',
  'unsafe',
  'while',
] as const

const Keywords = new Set<string>(VELAR_EDITOR_KEYWORDS)

const BuiltinTypes = new Set([
  'bool',
  'Error',
  'List',
  'Map',
  'number',
  'Promise',
  'Set',
  'string',
  'unknown',
])

function readString(stream: StringStream, state: VelarStreamState): string {
  const quote = state.stringQuote
  if (!quote) return 'string'

  let escaped = false
  while (!stream.eol()) {
    const char = stream.next()
    if (char === quote && state.rawString && stream.peek() === quote) {
      stream.next()
      continue
    }
    if (char === quote && (state.rawString || !escaped)) {
      state.stringQuote = null
      state.rawString = false
      break
    }
    if (!state.rawString) {
      escaped = !escaped && char === '\\'
      if (char !== '\\') escaped = false
    }
  }
  // Inline strings are recovery-bounded by their physical line. Only a quote
  // followed immediately by a newline enters the layout-string state below.
  if (stream.eol()) {
    state.stringQuote = null
    state.rawString = false
  }
  return 'string'
}

function beginString(stream: StringStream, state: VelarStreamState, raw: boolean): string {
  const quote = stream.next()
  if (!quote) return 'string'
  state.stringQuote = quote
  state.rawString = raw
  if (stream.eol()) {
    state.layoutString = true
    state.layoutIndent = state.lineIndent
    return 'string'
  }
  return readString(stream, state)
}

const VelarParser: StreamParser<VelarStreamState> = {
  startState: (indentUnit) => ({
    stringQuote: null,
    rawString: false,
    layoutString: false,
    layoutIndent: 0,
    indentUnit,
    lineIndent: 0,
    nextIndent: 0,
  }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (stream.sol()) {
      state.lineIndent = stream.indentation()
      state.nextIndent = state.lineIndent
      if (state.layoutString) {
        const blank = stream.string.trim().length === 0
        const closing = state.lineIndent === state.layoutIndent
          && stream.string.slice(state.lineIndent).startsWith(state.stringQuote ?? '\0')
        if (closing) {
          if (state.lineIndent > 0) stream.match(/^\s+/u)
          stream.next()
          state.stringQuote = null
          state.rawString = false
          state.layoutString = false
          return 'string'
        }
        if (blank || state.lineIndent > state.layoutIndent) {
          stream.skipToEnd()
          return 'string'
        }
        state.stringQuote = null
        state.rawString = false
        state.layoutString = false
      }
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }

    if (stream.match(/^(?:rf|f|r)(?=["'])/u))
      return beginString(stream, state, stream.current().includes('r'))

    const quote = stream.peek()
    if (quote === '"' || quote === "'") return beginString(stream, state, false)

    if (stream.match(/^(?:\d+(?:\.\d+)?|\.\d+)/u)) return 'number'
    if (stream.match(/^[A-Za-z_$][\w$]*/u)) {
      const word = stream.current()
      if (Keywords.has(word)) return 'keyword'
      if (BuiltinTypes.has(word)) return 'typeName'
      if (/^[A-Z]/u.test(word)) return 'className'
      return 'variableName'
    }

    if (stream.eat(':')) {
      if (/^\s*(?:\/\/.*)?$/u.test(stream.string.slice(stream.pos)))
        state.nextIndent = state.lineIndent + state.indentUnit
      return 'punctuation'
    }
    if (stream.eat('/') || stream.match(/^[+\-*%=!<>|&?:.]+/u)) return 'operator'
    if (stream.match(/^[()[\]{},;]/u)) return 'punctuation'
    stream.next()
    return null
  },
  indent: (state, textAfter) =>
    /^(?:else|catch|finally)\b/u.test(textAfter)
      ? Math.max(0, state.nextIndent - state.indentUnit)
      : state.nextIndent,
  languageData: {
    commentTokens: { line: '//' },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"'] },
    indentOnInput: /^\s*(?:else|catch|finally):?$/u,
  },
}

export function velarScript(): Extension {
  return StreamLanguage.define(VelarParser)
}

export const VelarWorkbenchEditorLanguage = {
  id: 'velarscript',
  languageId: 'velar',
  extensions: ['vel'],
  languages: ['velar', 'velarscript'],
  createExtension: velarScript,
  basicSyntax: {
    keywords: VELAR_EDITOR_KEYWORDS,
    lineComment: '//',
  },
  project: {
    markers: ['velar.json'],
    commands: [
      { id: 'install', label: 'Install Dependencies', command: 'velar', args: ['install'] },
      { id: 'update', label: 'Update Dependencies', command: 'velar', args: ['update'] },
      { id: 'check', label: 'Check', command: 'velar', args: ['check'] },
      { id: 'run', label: 'Run Core Project', command: 'velar', args: ['run'] },
      { id: 'format', label: 'Format Project', command: 'velar', args: ['format'] },
      { id: 'format-check', label: 'Check Formatting', command: 'velar', args: ['format', '--check'] },
      { id: 'dev', label: 'Dev Server', command: 'velar', args: ['dev'] },
      { id: 'test', label: 'Test', command: 'velar', args: ['test'] },
      { id: 'test-browser', label: 'Browser Test', command: 'velar', args: ['test', '--browser'] },
      { id: 'build', label: 'Production Build', command: 'velar', args: ['build'] },
      { id: 'verify', label: 'Verify Production Build', command: 'velar', args: ['verify'] },
      { id: 'preview', label: 'Production Preview', command: 'velar', args: ['preview'] },
      {
        id: 'verify-deployment',
        label: 'Verify Deployed Site',
        command: 'velar',
        args: ['verify-deployment'],
      },
    ],
  },
} satisfies WorkbenchEditorLanguageContribution
