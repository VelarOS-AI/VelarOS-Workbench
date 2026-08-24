import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import type { WorkbenchEditorLanguageContribution } from '@renderer/language/workbenchEditorLanguageContributions'

import { VELAR_LANGUAGE_KEYWORDS } from '@shared/contributions/velar/language'

interface VelarStreamState {
  stringQuote: string | null
  rawString: boolean
  interpolatedString: boolean
  interpolationDepth: number
  layoutString: boolean
  layoutIndent: number
  indentUnit: number
  lineIndent: number
  nextIndent: number
  nextIdentifierStyle: string | null
  memberAccess: boolean
  objectDepth: number
  objectKeyExpected: boolean
}

export const VELAR_EDITOR_KEYWORDS = VELAR_LANGUAGE_KEYWORDS

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

function resetString(state: VelarStreamState): void {
  state.stringQuote = null
  state.rawString = false
  state.interpolatedString = false
  state.interpolationDepth = 0
}

function readString(stream: StringStream, state: VelarStreamState, layout = false): string {
  const quote = state.stringQuote
  if (!quote) return 'string'

  let escaped = false
  while (!stream.eol()) {
    const char = stream.next()
    if (!state.rawString && escaped) {
      escaped = false
      continue
    }
    if (!state.rawString && char === '\\') {
      escaped = true
      continue
    }
    if (state.interpolatedString && char === '{') {
      if (stream.peek() === '{') {
        stream.next()
        continue
      }
      if (stream.pos - 1 > stream.start) {
        stream.backUp(1)
        return 'string'
      }
      state.interpolationDepth = 1
      return 'punctuation'
    }
    if (state.interpolatedString && char === '}' && stream.peek() === '}') {
      stream.next()
      continue
    }
    if (layout) continue
    if (char === quote && state.rawString && stream.peek() === quote) {
      stream.next()
      continue
    }
    if (char === quote) {
      resetString(state)
      break
    }
  }
  // Inline strings are recovery-bounded by their physical line. Only a quote
  // followed immediately by a newline enters the layout-string state below.
  if (stream.eol() && !layout) resetString(state)
  return 'string'
}

function beginString(
  stream: StringStream,
  state: VelarStreamState,
  raw: boolean,
  interpolated: boolean
): string {
  const quote = stream.next()
  if (!quote) return 'string'
  state.stringQuote = quote
  state.rawString = raw
  state.interpolatedString = interpolated
  state.interpolationDepth = 0
  if (quote === '"' && stream.eol()) {
    state.layoutString = true
    state.layoutIndent = state.lineIndent
    return 'string'
  }
  return readString(stream, state)
}

function readNestedInterpolationString(stream: StringStream, raw: boolean): string {
  const quote = stream.next()
  if (!quote) return 'string'
  let escaped = false
  while (!stream.eol()) {
    const char = stream.next()
    if (!raw && escaped) {
      escaped = false
      continue
    }
    if (!raw && char === '\\') {
      escaped = true
      continue
    }
    if (char === quote && raw && stream.peek() === quote) {
      stream.next()
      continue
    }
    if (char === quote) break
  }
  return 'string'
}

const VelarParser: StreamParser<VelarStreamState> = {
  startState: (indentUnit) => ({
    stringQuote: null,
    rawString: false,
    interpolatedString: false,
    interpolationDepth: 0,
    layoutString: false,
    layoutIndent: 0,
    indentUnit,
    lineIndent: 0,
    nextIndent: 0,
    nextIdentifierStyle: null,
    memberAccess: false,
    objectDepth: 0,
    objectKeyExpected: false,
  }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (stream.sol()) {
      if (state.stringQuote && !state.layoutString) resetString(state)
      state.lineIndent = stream.indentation()
      state.nextIndent = state.lineIndent
      if (state.layoutString && state.interpolationDepth === 0) {
        const blank = stream.string.trim().length === 0
        const closing = state.lineIndent === state.layoutIndent
          && stream.string.slice(state.lineIndent).startsWith(state.stringQuote ?? '\0')
        if (closing) {
          if (state.lineIndent > 0) stream.match(/^\s+/u)
          stream.next()
          state.layoutString = false
          resetString(state)
          return 'string'
        }
        if (blank || state.lineIndent > state.layoutIndent) {
          if (!state.interpolatedString || blank) {
            stream.skipToEnd()
            return 'string'
          }
        }
        if (!blank && state.lineIndent <= state.layoutIndent) {
          state.layoutString = false
          resetString(state)
        }
      }
    }
    if (state.stringQuote && state.interpolationDepth === 0)
      return readString(stream, state, state.layoutString)
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }

    if (state.interpolationDepth > 0) {
      if (stream.match(/^(?:rf|f|r)(?=["'`])/u))
        return readNestedInterpolationString(stream, stream.current().includes('r'))
      const nestedQuote = stream.peek()
      if (nestedQuote === '"' || nestedQuote === "'" || nestedQuote === '`')
        return readNestedInterpolationString(stream, false)
      if (stream.eat('{')) {
        state.interpolationDepth += 1
        return 'punctuation'
      }
      if (stream.eat('}')) {
        state.interpolationDepth -= 1
        return 'punctuation'
      }
    }

    if (stream.match(/^(?:rf|f|r)(?=["'`])/u)) {
      const prefix = stream.current()
      return beginString(stream, state, prefix.includes('r'), prefix.includes('f'))
    }

    const quote = stream.peek()
    if (quote === '"' || quote === "'" || quote === '`')
      return beginString(stream, state, false, quote === '`')

    if (stream.match(/^0(?:[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*|[bB][01](?:_?[01])*|[oO][0-7](?:_?[0-7])*)/u))
      return 'number'
    if (stream.match(/^(?:\d(?:_?\d)*(?:\.\d(?:_?\d)*)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/u))
      return 'number'
    if (stream.match(/^[A-Za-z_$][\w$]*/u)) {
      const word = stream.current()
      const nextIdentifierStyle = state.nextIdentifierStyle
      state.nextIdentifierStyle = null
      if (state.memberAccess) {
        state.memberAccess = false
        return /^\s*\(/u.test(stream.string.slice(stream.pos))
          ? 'propertyName.function'
          : 'propertyName'
      }
      if (
        state.objectDepth > 0
        && state.objectKeyExpected
        && /^\s*(?::|[,}])/u.test(stream.string.slice(stream.pos))
      ) {
        state.objectKeyExpected = false
        return 'propertyName'
      }
      if (state.objectDepth > 0 && state.objectKeyExpected) state.objectKeyExpected = false
      if (nextIdentifierStyle) return nextIdentifierStyle
      if (Keywords.has(word)) {
        if (word === 'def') state.nextIdentifierStyle = 'variableName.definition.function'
        else if (word === 'class') state.nextIdentifierStyle = 'className.definition'
        else if (word === 'type' || word === 'enum' || word === 'interface')
          state.nextIdentifierStyle = 'typeName.definition'
        else if (word === 'const' || word === 'let' || word === 'var')
          state.nextIdentifierStyle = 'variableName.definition'
        return 'keyword'
      }
      if (BuiltinTypes.has(word)) return 'typeName'
      if (/^[A-Z]/u.test(word)) return 'className'
      if (/^\s*\(/u.test(stream.string.slice(stream.pos))) return 'variableName.function'
      return 'variableName'
    }

    if (stream.eat(':')) {
      if (state.objectDepth > 0) state.objectKeyExpected = false
      if (/^\s*(?:\/\/.*)?$/u.test(stream.string.slice(stream.pos)))
        state.nextIndent = state.lineIndent + state.indentUnit
      return 'punctuation'
    }
    if (stream.eat('.')) {
      state.memberAccess = true
      if (state.objectDepth > 0) state.objectKeyExpected = false
      return 'operator'
    }
    if (stream.eat('/') || stream.match(/^[+\-*%=!<>|&^~?:]+/u)) {
      state.memberAccess = false
      if (state.objectDepth > 0) state.objectKeyExpected = false
      return 'operator'
    }
    if (stream.match(/^[()[\]{},;]/u)) {
      const punctuation = stream.current()
      if (punctuation === '{') {
        state.objectDepth += 1
        state.objectKeyExpected = true
      } else if (punctuation === '}') {
        state.objectDepth = Math.max(0, state.objectDepth - 1)
        state.objectKeyExpected = false
      } else if (punctuation === ',' && state.objectDepth > 0) {
        state.objectKeyExpected = true
      }
      return 'punctuation'
    }
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
