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

  test('keep special filenames separate from ordinary suffixes in both cache orders', () => {
    const first = 'name = "first"'
    const second = 'name = "second"'
    const render = (path: string, text: string) =>
      highlightWorkbenchCodeSnippet({ path, text, theme: 'light-modern' })

    const tomlFirst = render('control.toml', first)
    const tomlSecond = render('control.toml', second)
    expect(tomlFirst.some((token) => !!token.style)).toBe(true)
    expect(render('ordinary.lock', first)).toEqual([{ text: first }])
    // 相同正文经过 snippet 缓存，不同正文经过 parser 缓存。
    expect(render('Cargo.lock', first)).toEqual(tomlFirst)
    expect(render('Cargo.lock', second)).toEqual(tomlSecond)

    const propertiesFirst = render('.env', first)
    expect(propertiesFirst.some((token) => !!token.style)).toBe(true)
    expect(render('.env.local', first)).toEqual(propertiesFirst)
    expect(render('ordinary.local', first)).toEqual([{ text: first }])
    expect(render('ordinary.local', second)).toEqual([{ text: second }])
  })
})
