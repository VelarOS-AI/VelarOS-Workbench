import assert from 'node:assert/strict'

import { highlightingFor } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { type Tag, tags } from '@lezer/highlight'
import { test } from 'bun:test'

import {
  buildWorkbenchSemanticTokenDecorations,
  getWorkbenchSemanticTokenTheme,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorSemanticTokens'
import {
  getWorkbenchCodeMirrorTheme,
  getWorkbenchCodeTokenPalette,
  type WorkbenchCodeTokenPalette,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorTheme'
import type { WorkbenchThemeId } from '../src/renderer/src/models/settings/workbenchPreferences'

function semanticThemeRules(theme: WorkbenchThemeId): string {
  const state = EditorState.create({ extensions: [getWorkbenchSemanticTokenTheme(theme)] })
  return state.facet(EditorView.styleModule).flatMap((module) => module.getRules()).join('\n')
}

function syntaxTheme(theme: WorkbenchThemeId): { readonly rules: string; readonly state: EditorState } {
  const state = EditorState.create({ extensions: [getWorkbenchCodeMirrorTheme(theme)] })
  return {
    rules: state.facet(EditorView.styleModule).flatMap((module) => module.getRules()).join('\n'),
    state,
  }
}

function colorForSyntaxTag(state: EditorState, rules: string, tag: Tag): string {
  const className = highlightingFor(state, [tag])
  assert.ok(className)
  const rule = rules.split('\n').find((candidate) => candidate.includes(`.${className} {`))
  assert.ok(rule)
  return /color: ([^;]+);/u.exec(rule)?.[1] ?? ''
}

function colorForSemanticRole(rules: string, role: string): string {
  const rule = rules
    .split('\n')
    .find((candidate) => candidate.includes(`.cm-workbenchSemantic-${role}`))
  assert.ok(rule)
  return /color: ([^ ;]+) !important;/u.exec(rule)?.[1] ?? ''
}

void test('basic syntax and semantic tokens share one role palette in every theme', () => {
  const cases: ReadonlyArray<[
    keyof Pick<
      WorkbenchCodeTokenPalette,
      'frameworkDefinition' | 'function' | 'keyword' | 'property' | 'type' | 'variable'
    >,
    Tag,
    string,
  ]> = [
    ['keyword', tags.keyword, 'keyword'],
    ['function', tags.function(tags.variableName), 'function'],
    ['type', tags.typeName, 'type'],
    ['property', tags.propertyName, 'property'],
    ['frameworkDefinition', tags.special(tags.definition(tags.variableName)), 'frameworkDefinition'],
    ['variable', tags.variableName, 'variable'],
  ]
  const themes: readonly WorkbenchThemeId[] = [
    'light-modern',
    'dark-modern',
    'warm-paper',
    'midnight-blue',
  ]

  for (const theme of themes) {
    const palette = getWorkbenchCodeTokenPalette(theme)
    const syntax = syntaxTheme(theme)
    const semanticRules = semanticThemeRules(theme)
    for (const [paletteRole, tag, semanticRole] of cases) {
      assert.equal(colorForSyntaxTag(syntax.state, syntax.rules, tag), palette[paletteRole])
      assert.equal(colorForSemanticRole(semanticRules, semanticRole), palette[paletteRole])
    }
    assert.equal(colorForSemanticRole(semanticRules, 'builtinType'), palette.type)
    assert.equal(colorForSemanticRole(semanticRules, 'enumMember'), palette.property)
  }
})

void test('semantic keywords are blue while class-like built-ins use the type color', () => {
  const dark = semanticThemeRules('dark-modern')
  const light = semanticThemeRules('light-modern')

  assert.match(dark, /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #569cd6 !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #0033b3 !important;\}/u)
  assert.match(dark, /cm-workbenchSemantic-decorator, .*cm-workbenchSemantic-decorator \* \{color: #c8a56c !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-decorator, .*cm-workbenchSemantic-decorator \* \{color: #808000 !important;\}/u)
  assert.match(dark, /cm-workbenchSemantic-builtinType \* \{color: #4ec9b0 !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-builtinType \* \{color: #007f73 !important;\}/u)
  assert.match(dark, /cm-workbenchSemantic-frameworkDefinition \* \{color: #ff8c42 !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-frameworkDefinition \* \{color: #6f42c1 !important;\}/u)
})

void test('enum members use the same purple property color in every theme', () => {
  const cases: ReadonlyArray<[WorkbenchThemeId, string]> = [
    ['light-modern', '#a31574'],
    ['dark-modern', '#e394dc'],
    ['warm-paper', '#9d174d'],
    ['midnight-blue', '#f07178'],
  ]

  for (const [theme, propertyColor] of cases) {
    const rules = semanticThemeRules(theme)
    assert.match(
      rules,
      new RegExp(`cm-workbenchSemantic-enumMember \\* \\{color: ${propertyColor} !important;`, 'u')
    )
    assert.match(
      rules,
      new RegExp(`cm-workbenchSemantic-property[^\\n]*\\{color: ${propertyColor} !important;`, 'u')
    )
  }
})

void test('framework declarations keep their dedicated color across language-server token kinds', () => {
  const content = 'component App:\nexport server api:\nstate ready = true\nconst ordinary = true\n'
  const decorations = buildWorkbenchSemanticTokenDecorations(content, [
    {
      range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 14 },
      type: 'function',
      modifiers: ['declaration', 'frameworkDefinition'],
    },
    {
      range: { startLine: 2, startColumn: 15, endLine: 2, endColumn: 18 },
      type: 'variable',
      modifiers: ['declaration', 'frameworkDefinition'],
    },
    {
      range: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 12 },
      type: 'variable',
      modifiers: ['declaration', 'frameworkDefinition'],
    },
    {
      range: { startLine: 4, startColumn: 7, endLine: 4, endColumn: 15 },
      type: 'variable',
      modifiers: ['declaration'],
    },
  ])
  const classes: string[] = []
  decorations.between(0, content.length, (_from, _to, value) => {
    classes.push(String(value.spec.class))
  })

  assert.equal(classes.length, 4)
  for (const className of classes.slice(0, 3))
    assert.match(className, /cm-workbenchSemantic-frameworkDefinition/u)
  assert.match(classes[3] ?? '', /cm-workbenchSemantic-variable/u)
  assert.doesNotMatch(classes[3] ?? '', /cm-workbenchSemantic-frameworkDefinition/u)
})

void test('framework definitions have a unique semantic color in every theme', () => {
  const themes: readonly WorkbenchThemeId[] = [
    'light-modern',
    'dark-modern',
    'warm-paper',
    'midnight-blue',
  ]

  for (const theme of themes) {
    const palette = getWorkbenchCodeTokenPalette(theme)
    const semanticColors = new Set([
      palette.decorator,
      palette.frameworkDefinition,
      palette.function,
      palette.keyword,
      palette.property,
      palette.type,
      palette.variable,
    ])
    assert.equal(semanticColors.size, 7, `${theme} reuses a semantic role color`)

    const rules = semanticThemeRules(theme)
    assert.equal(colorForSemanticRole(rules, 'frameworkDefinition'), palette.frameworkDefinition)
    assert.equal(colorForSemanticRole(rules, 'enumMember'), palette.property)
    assert.equal(colorForSemanticRole(rules, 'builtinType'), palette.type)
  }
})

void test('built-in runtime objects and nested semantic spans keep their semantic colors', () => {
  const content = 'Date Math TimerScope'
  const decorations = buildWorkbenchSemanticTokenDecorations(content, [
    {
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
      type: 'class',
      modifiers: ['defaultLibrary'],
    },
    {
      range: { startLine: 1, startColumn: 6, endLine: 1, endColumn: 10 },
      type: 'variable',
      modifiers: ['defaultLibrary'],
    },
    {
      range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 21 },
      type: 'class',
      modifiers: [],
    },
  ])
  const classes: string[] = []
  decorations.between(0, content.length, (_from, _to, value) => {
    classes.push(String(value.spec.class))
  })

  assert.match(classes[0] ?? '', /cm-workbenchSemantic-builtinType/u)
  assert.match(classes[1] ?? '', /cm-workbenchSemantic-builtinType/u)
  assert.match(classes[2] ?? '', /cm-workbenchSemantic-class/u)

  const light = semanticThemeRules('light-modern')
  assert.match(
    light,
    /cm-workbenchSemantic-class \*[^\n]*\{color: #007f73 !important;/u
  )
  assert.match(
    light,
    /cm-workbenchSemantic-builtinType \* \{color: #007f73 !important;/u
  )
})

void test('readonly local variables retain the ordinary variable color', () => {
  const light = semanticThemeRules('light-modern')
  const dark = semanticThemeRules('dark-modern')

  assert.match(
    light,
    /cm-workbenchSemantic-variable \* \{color: #202124 !important;/u
  )
  assert.match(
    dark,
    /cm-workbenchSemantic-variable \* \{color: #d8dee9 !important;/u
  )
  assert.doesNotMatch(light, /variable\.cm-workbenchSemanticModifier-readonly/u)
  assert.doesNotMatch(dark, /variable\.cm-workbenchSemanticModifier-readonly/u)
})

void test('function parameters retain the ordinary variable color', () => {
  const light = semanticThemeRules('light-modern')
  const dark = semanticThemeRules('dark-modern')

  assert.match(
    light,
    /cm-workbenchSemantic-parameter \* \{color: #202124 !important;/u
  )
  assert.match(
    dark,
    /cm-workbenchSemantic-parameter \* \{color: #d8dee9 !important;/u
  )
})
