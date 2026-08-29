import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { getWorkbenchCodeMirrorAutocompleteTheme } from '../src/renderer/src/models/editor/workbenchCodeMirrorAutocompleteTheme'
import {
  WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS,
  WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorCompletionPresentation'
import type { WorkbenchThemeId } from '../src/renderer/src/models/settings/workbenchPreferences'

function autocompleteThemeRules(theme: WorkbenchThemeId): string {
  const state = EditorState.create({ extensions: [getWorkbenchCodeMirrorAutocompleteTheme(theme)] })
  return state.facet(EditorView.styleModule).flatMap((module) => module.getRules()).join('\n')
}

void test('completion geometry follows editor metrics instead of a fixed popup scale', () => {
  const rules = autocompleteThemeRules('light-modern')

  assert.match(rules, /font-size: var\(--workbench-editor-font-size, 12\.5px\)/u)
  assert.match(rules, /line-height: var\(--workbench-editor-line-height, 20\.25px\)/u)
  assert.match(
    rules,
    /max-height: min\(calc\(var\(--workbench-editor-line-height, 20\.25px\) \* 12\), 48vh\)/u
  )
})

void test('completion selection derives its surface and accent from the live Workbench theme', () => {
  const light = autocompleteThemeRules('light-modern')
  const dark = autocompleteThemeRules('dark-modern')

  for (const rules of [light, dark]) {
    assert.match(rules, /var\(--workbench-theme-color\)/u)
    assert.match(rules, /var\(--workbench-editor-tooltip-bg, var\(--workbench-bg\)\)/u)
    assert.match(rules, /box-shadow: inset 2px 0 0 var\(--workbench-theme-color\)/u)
  }
  assert.match(light, /var\(--workbench-theme-color\) 14%/u)
  assert.match(dark, /var\(--workbench-theme-color\) 22%/u)
})

void test('completion kinds use semantic icons instead of letter badges', () => {
  const rules = autocompleteThemeRules('light-modern')

  assert.match(rules, /cm-completionIcon-function[^}]*border: 0/u)
  assert.match(rules, /cm-completionIcon-keyword[^}]*mask-image: url/u)
  assert.match(rules, /cm-completionIcon-class[^}]*mask-image: url/u)
  assert.match(rules, /cm-completionIcon-variable[^}]*mask-image: url/u)
  assert.doesNotMatch(rules, /cm-completionIcon-(?:keyword|class|variable)::after/u)
})

void test('completion starts promptly while language results update asynchronously', () => {
  assert.ok(WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS <= 50)
  assert.ok(WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS <= 50)
})
