import { describe, expect, test } from 'bun:test'

import { getWorkbenchCodeTokenPalette } from '../src/renderer/src/models/editor/workbenchCodeMirrorTheme'
import { highlightWorkbenchCodeSnippet } from '../src/renderer/src/models/editor/workbenchCodeSnippetHighlight'

describe('search result code snippets', () => {
  test('are coloured with the editor palette for the file language', () => {
    const palette = getWorkbenchCodeTokenPalette('light-modern')
    const tokens = highlightWorkbenchCodeSnippet({
      path: 'src/index.ts',
      text: "const name = 'calc'",
      theme: 'light-modern',
    })
    expect(tokens.map((token) => token.text).join('')).toBe("const name = 'calc'")
    expect(tokens.find((token) => token.text === 'const')?.style?.color).toBe(palette.keyword)
    expect(tokens.find((token) => token.text === "'calc'")?.style?.color).toBe(palette.string)
  })

  test('mark every case-insensitive occurrence of the query without changing colours', () => {
    const tokens = highlightWorkbenchCodeSnippet({
      path: 'src/index.ts',
      text: 'const calc = new Calculator()',
      theme: 'light-modern',
      query: 'calc',
    })
    expect(tokens.filter((token) => token.match).map((token) => token.text)).toEqual(['calc', 'Calc'])
    const rest = tokens.find((token) => token.text === 'ulator')
    const marked = tokens.find((token) => token.text === 'Calc')
    expect(rest?.style?.color).toBe(marked?.style?.color)
  })

  test('keep the truncation dots plain and fall back to plain text for unknown languages', () => {
    const truncated = highlightWorkbenchCodeSnippet({
      path: 'src/index.ts',
      text: '...return total...',
      theme: 'dark-modern',
    })
    expect(truncated[0]).toEqual({ text: '...' })
    expect(truncated.at(-1)).toEqual({ text: '...' })
    expect(
      highlightWorkbenchCodeSnippet({ path: 'notes.unknown', text: 'plain words', theme: 'light-modern' })
    ).toEqual([{ text: 'plain words' }])
  })
})
