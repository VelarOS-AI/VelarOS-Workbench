import assert from 'node:assert/strict'

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { test } from 'bun:test'

import {
  buildWorkbenchSemanticTokenDecorations,
  getWorkbenchSemanticTokenTheme,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorSemanticTokens'
import type { WorkbenchThemeId } from '../src/renderer/src/models/settings/workbenchPreferences'

function semanticThemeRules(theme: WorkbenchThemeId): string {
  const state = EditorState.create({ extensions: [getWorkbenchSemanticTokenTheme(theme)] })
  return state.facet(EditorView.styleModule).flatMap((module) => module.getRules()).join('\n')
}

void test('semantic keywords are blue while class-like built-ins use the type color', () => {
  const dark = semanticThemeRules('dark-modern')
  const light = semanticThemeRules('light-modern')

  assert.match(dark, /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #569cd6 !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #0033b3 !important;\}/u)
  assert.match(dark, /cm-workbenchSemantic-decorator, .*cm-workbenchSemantic-decorator \* \{color: #c8a56c !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-decorator, .*cm-workbenchSemantic-decorator \* \{color: #808000 !important;\}/u)
  assert.match(dark, /cm-workbenchSemantic-builtinType \* \{color: #4ec9b0 !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-builtinType \* \{color: #007f73 !important;\}/u)
  assert.match(dark, /cm-workbenchSemantic-frameworkDefinition \* \{color: #d16d9e !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-frameworkDefinition \* \{color: #9c27b0 !important;\}/u)
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
  const content = 'component App:\nexport server api:\nstate ready = true\n'
  const decorations = buildWorkbenchSemanticTokenDecorations(content, [
    {
      range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 14 },
      type: 'function',
      modifiers: ['declaration'],
    },
    {
      range: { startLine: 2, startColumn: 15, endLine: 2, endColumn: 18 },
      type: 'variable',
      modifiers: ['declaration'],
    },
    {
      range: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 12 },
      type: 'variable',
      modifiers: ['declaration'],
    },
  ])
  const classes: string[] = []
  decorations.between(0, content.length, (_from, _to, value) => {
    classes.push(String(value.spec.class))
  })

  assert.equal(classes.length, 3)
  for (const className of classes)
    assert.match(className, /cm-workbenchSemantic-frameworkDefinition/u)
})

void test('color themes use distinct semantic palettes', () => {
  const warmPaper = semanticThemeRules('warm-paper')
  const midnightBlue = semanticThemeRules('midnight-blue')

  assert.match(warmPaper, /cm-workbenchSemantic-keyword, .*color: #7c3aed !important;/u)
  assert.match(warmPaper, /cm-workbenchSemantic-typeParameter \* \{color: #0f766e !important;/u)
  assert.match(midnightBlue, /cm-workbenchSemantic-keyword, .*color: #c792ea !important;/u)
  assert.match(midnightBlue, /cm-workbenchSemantic-typeParameter \* \{color: #89ddff !important;/u)
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
