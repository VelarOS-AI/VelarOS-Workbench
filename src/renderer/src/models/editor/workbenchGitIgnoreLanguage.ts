import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'

interface GitIgnoreParserState {
  atLineStart: boolean
}

const gitIgnoreStreamParser: StreamParser<GitIgnoreParserState> = {
  name: 'gitignore',
  startState: () => ({ atLineStart: true }),
  languageData: {
    commentTokens: { line: '#' },
  },
  token(stream: StringStream, state: GitIgnoreParserState): string | null {
    if (stream.sol()) state.atLineStart = true
    if (stream.eatSpace()) return null

    if (state.atLineStart && stream.peek() === '#') {
      stream.skipToEnd()
      state.atLineStart = false
      return 'comment'
    }
    if (state.atLineStart && stream.eat('!')) {
      state.atLineStart = false
      return 'operator'
    }

    state.atLineStart = false
    if (stream.eat('\\')) {
      stream.next()
      return 'escape'
    }
    if (stream.match(/\*\*|\*|\?|\[[^\]]*\]/u)) return 'regexp'
    if (stream.eat('/')) return 'punctuation'

    stream.eatWhile((character) => !'\\*?[/'.includes(character))
    if (!stream.current()) stream.next()
    return 'string'
  },
}

export const workbenchGitIgnoreLanguage = StreamLanguage.define(gitIgnoreStreamParser)
