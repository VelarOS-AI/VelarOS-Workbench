import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import type { WorkbenchEditorLanguageContribution } from '@workbench/language'

interface VelarStreamState {
  stringQuote: string | null
  tripleQuoted: boolean
  indentUnit: number
  lineIndent: number
  nextIndent: number
}

export const VELAR_EDITOR_KEYWORDS = [
  'abstract',
  'and',
  'as',
  'async',
  'await',
  'break',
  'catch',
  'case',
  'class',
  'cleanup',
  'component',
  'computed',
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
  'global',
  'if',
  'import',
  'in',
  'is',
  'js',
  'let',
  'match',
  'mounted',
  'module',
  'none',
  'not',
  'or',
  'override',
  'pass',
  'return',
  'state',
  'static',
  'style',
  'super',
  'throw',
  'true',
  'try',
  'type',
  'unsafe',
  'watch',
  'while',
] as const

const Keywords = new Set<string>(VELAR_EDITOR_KEYWORDS)

const BuiltinTypes = new Set([
  'bool',
  'CanvasElement',
  'Element',
  'Event',
  'Error',
  'InputElement',
  'List',
  'Map',
  'number',
  'Promise',
  'string',
  'unknown',
  'WebNode',
])

function readString(stream: StringStream, state: VelarStreamState): string {
  const quote = state.stringQuote
  if (!quote) return 'string'

  let escaped = false
  while (!stream.eol()) {
    if (state.tripleQuoted && stream.match(quote.repeat(3))) {
      state.stringQuote = null
      state.tripleQuoted = false
      break
    }

    const char = stream.next()
    if (!state.tripleQuoted && !escaped && char === quote) {
      state.stringQuote = null
      break
    }
    escaped = !escaped && char === '\\'
    if (char !== '\\') escaped = false
  }
  return 'string'
}

const VelarParser: StreamParser<VelarStreamState> = {
  startState: (indentUnit) => ({
    stringQuote: null,
    tripleQuoted: false,
    indentUnit,
    lineIndent: 0,
    nextIndent: 0,
  }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (stream.sol()) {
      state.lineIndent = stream.indentation()
      state.nextIndent = state.lineIndent
    }
    if (state.stringQuote) return readString(stream, state)
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }

    if (stream.match(/^f(?=["'])/u)) {
      const quote = stream.next()
      if (!quote) return 'string'
      state.stringQuote = quote
      state.tripleQuoted = !!stream.match(quote.repeat(2))
      return readString(stream, state)
    }

    const quote = stream.peek()
    if (quote === '"' || quote === "'") {
      stream.next()
      state.stringQuote = quote
      state.tripleQuoted = !!stream.match(quote.repeat(2))
      return readString(stream, state)
    }

    if (stream.match(/^(?:\d+(?:\.\d+)?|\.\d+)/u)) return 'number'
    if (stream.match(/^(?:bind|class|style|on):[\w-]+(?:\.[\w-]+)*/u)) return 'attributeName'
    if (stream.match(/^[A-Za-z_$][\w$]*/u)) {
      const word = stream.current()
      if (Keywords.has(word)) return 'keyword'
      if (BuiltinTypes.has(word)) return 'typeName'
      if (/^[A-Z]/u.test(word)) return 'className'
      return 'variableName'
    }

    if (stream.match(/^<\/?[A-Za-z][\w.-]*/u)) return 'tagName'
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
      { id: 'check', label: 'Check', command: 'velar', args: ['check'] },
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
      { id: 'upgrade-check', label: 'Project Upgrade Check', command: 'velar', args: ['upgrade', '--check'] },
    ],
  },
} satisfies WorkbenchEditorLanguageContribution
