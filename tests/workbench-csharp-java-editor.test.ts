import { CompletionContext } from '@codemirror/autocomplete'
import {
  foldable,
  getIndentation,
  highlightingFor,
  indentUnit,
  syntaxTree,
} from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree, type Tag, tags } from '@lezer/highlight'
import { expect, test } from 'bun:test'

import { resolveWorkbenchOfflineCodeCompletion } from '../src/renderer/src/models/editor/workbenchCodeMirrorCompletions'
import { resolveWorkbenchCodeMirrorLanguage } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguage'
import {
  getWorkbenchCodeMirrorTheme,
  getWorkbenchCodeTokenPalette,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorTheme'
import { highlightWorkbenchCodeSnippet } from '../src/renderer/src/models/editor/workbenchCodeSnippetHighlight'

const theme = 'dark-modern'
const palette = getWorkbenchCodeTokenPalette(theme)

function editorState(path: string, doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      resolveWorkbenchCodeMirrorLanguage(path, '').extension,
      getWorkbenchCodeMirrorTheme(theme),
      indentUnit.of('  '),
    ],
  })
}

function expectHighlights(state: EditorState, examples: Record<string, Tag>): void {
  const tree = syntaxTree(state)
  const ranges: Array<{ from: number; to: number; classes: string }> = []
  highlightTree(tree, { style: (styles) => highlightingFor(state, styles) }, (from, to, classes) =>
    ranges.push({ from, to, classes })
  )
  const source = state.doc.toString()
  for (const [text, tag] of Object.entries(examples)) {
    const offset = source.indexOf(text)
    expect(offset, text).toBeGreaterThanOrEqual(0)
    const style = highlightingFor(state, [tag])
    expect(style, text).toBeTruthy()
    expect(ranges.find(({ from, to }) => from <= offset && to > offset)?.classes, text).toBe(style)
  }
}

test('C# syntax distinguishes classes, properties, functions, attributes and interpolation', () => {
  const state = editorState(
    'Example.cs',
    [
      'namespace Example;',
      '[System.Obsolete("old")]',
      'public sealed record Widget(string Name) {',
      '  private readonly int offset = 5;',
      '  public required int Count { get; init; }',
      '  public string Render() {',
      '    return $"Count: {Count + offset:N0}";',
      '  }',
      '}',
    ].join('\n')
  )

  expectHighlights(state, {
    namespace: tags.keyword,
    'System.Obsolete': tags.annotation,
    'Widget(': tags.typeName,
    'Name)': tags.propertyName,
    'offset =': tags.propertyName,
    'Count {': tags.propertyName,
    'Render()': tags.function(tags.variableName),
    '$"Count:': tags.string,
    'Count +': tags.variableName,
  })
  const method = state.doc.line(6)
  expect(foldable(state, method.from, method.to)).toBeTruthy()
  expect(getIndentation(state, state.doc.line(7).from)).toBe(4)
  expect(state.languageDataAt('commentTokens', method.from)).toContainEqual({
    line: '//',
    block: { open: '/*', close: '*/' },
  })
})

test('C# scripts colour directives and multiline raw strings in the editor', () => {
  const state = editorState(
    'Script.csx',
    '#r "tools.dll"\nvar text = """\nraw // {text}\n""";\nConsole.WriteLine(text);'
  )
  expectHighlights(state, {
    '#r': tags.processingInstruction,
    'raw //': tags.string,
    'WriteLine(': tags.function(tags.propertyName),
  })
})

test('Java syntax and editing support records, annotations, generics and sealed classes', () => {
  const state = editorState(
    'Demo.java',
    [
      'package com.example;',
      '@pkg.Mark(key = "example")',
      'public record Box<T>(T value) {',
      '  private static final int COUNT = 1;',
      '  @Override public String toString() {',
      '    return String.valueOf(value);',
      '  }',
      '}',
      '@interface Flag {',
      '  String description();',
      '}',
      'sealed class Shape permits Circle {}',
      'final class Circle extends Shape {}',
    ].join('\n')
  )

  expectHighlights(state, {
    'com.example': tags.namespace,
    'pkg.Mark': tags.annotation,
    'key =': tags.propertyName,
    record: tags.keyword,
    'Box<': tags.typeName,
    'T>': tags.typeName,
    'value)': tags.propertyName,
    'COUNT =': tags.propertyName,
    '@Override': tags.annotation,
    'toString()': tags.function(tags.variableName),
    'valueOf(': tags.function(tags.variableName),
    'description()': tags.function(tags.variableName),
    'sealed class': tags.keyword,
    'permits Circle': tags.keyword,
  })
  for (const line of [state.doc.line(3), state.doc.line(9)]) {
    expect(foldable(state, line.from, line.to)).toBeTruthy()
  }
  expect(getIndentation(state, state.doc.line(4).from)).toBe(2)
  expect(getIndentation(state, state.doc.line(10).from)).toBe(2)
})

test('C# and Java colours are shared by fenced code and search snippets', () => {
  const state = editorState(
    'README.md',
    '```csharp\nrecord CSharpRecord(int Count);\n```\n\n```java\nrecord JavaRecord(int count) {}\n```'
  )
  expectHighlights(state, { CSharpRecord: tags.typeName, JavaRecord: tags.typeName })
  for (const [path, text] of [
    ['Widget.cs', 'record Sample(int Count);'],
    ['Widget.java', 'record Sample(int count) {}'],
  ]) {
    const tokens = highlightWorkbenchCodeSnippet({ path, text, theme, query: 'Sample' })
    expect(tokens.map((token) => token.text).join('')).toBe(text)
    expect(tokens.find((token) => token.match)).toEqual({
      text: 'Sample',
      match: true,
      style: { color: palette.type },
    })
  }
})

test('C# project XML and Java Gradle files have their own syntax', () => {
  for (const path of [
    'App.csproj',
    'Directory.Build.props',
    'Directory.Build.targets',
    'App.slnx',
    'Strings.resx',
    'pom.xml',
  ]) {
    expect(resolveWorkbenchCodeMirrorLanguage(path, '').languageId).toBe('xml')
  }
  expectHighlights(editorState('App.csproj', '<Project Sdk="Microsoft.NET.Sdk"/>'), {
    'Project ': tags.tagName,
    'Sdk=': tags.attributeName,
  })
  expectHighlights(editorState('build.gradle', "plugins { id 'java' }"), { "'java'": tags.string })
  expect(resolveWorkbenchCodeMirrorLanguage('build.gradle.kts', '').languageId).toBe('kotlin')
})

test('C# and Java locally complete keywords in code while leaving member lookup to the server', async () => {
  for (const path of ['Widget.cs', 'Widget.csx', 'Widget.java']) {
    const complete = resolveWorkbenchOfflineCodeCompletion(path)!
    const at = (doc: string, position: number) =>
      complete(new CompletionContext(editorState(path, doc), position, false))
    const options = await at('rec', 3)
    expect(options?.options).toContainEqual({ label: 'record', type: 'keyword' })
    expect(await at('// rec', 6)).toBeNull()
    expect(await at('class Widget { void Run() { var s = "rec"; } }', 40)).toBeNull()
    expect(await at('object.rec', 10)).toBeNull()
  }
})
