import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { getWorkbenchSemanticTokenTheme } from '../src/renderer/src/models/editor/workbenchCodeMirrorSemanticTokens'

function semanticThemeRules(theme: 'dark-modern' | 'light-modern'): string {
  const state = EditorState.create({ extensions: [getWorkbenchSemanticTokenTheme(theme)] })
  return state.facet(EditorView.styleModule).flatMap((module) => module.getRules()).join('\n')
}

void test('semantic keywords are blue and decorators retain annotation yellow through nested syntax spans', () => {
  const dark = semanticThemeRules('dark-modern')
  const light = semanticThemeRules('light-modern')

  assert.match(dark, /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #569cd6 !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #0033b3 !important;\}/u)
  assert.match(dark, /cm-workbenchSemantic-decorator, .*cm-workbenchSemantic-decorator \* \{color: #c8a56c !important;\}/u)
  assert.match(light, /cm-workbenchSemantic-decorator, .*cm-workbenchSemantic-decorator \* \{color: #808000 !important;\}/u)
})
