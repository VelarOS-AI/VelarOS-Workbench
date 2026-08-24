import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { getWorkbenchSemanticTokenTheme } from '../src/renderer/src/models/editor/workbenchCodeMirrorSemanticTokens'

function semanticThemeRules(theme: 'dark-modern' | 'light-modern'): string {
  const state = EditorState.create({ extensions: [getWorkbenchSemanticTokenTheme(theme)] })
  return state.facet(EditorView.styleModule).flatMap((module) => module.getRules()).join('\n')
}

void test('semantic keywords override nested syntax spans in dark and light editor themes', () => {
  assert.match(
    semanticThemeRules('dark-modern'),
    /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #c586c0 !important;\}/u
  )
  assert.match(
    semanticThemeRules('light-modern'),
    /cm-workbenchSemantic-keyword, .*cm-workbenchSemantic-keyword \* \{color: #af00db !important;\}/u
  )
})
