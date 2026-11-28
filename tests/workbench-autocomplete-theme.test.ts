import assert from 'node:assert/strict'

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { test } from 'bun:test'

import { getWorkbenchCodeMirrorAutocompleteTheme } from '../src/renderer/src/models/editor/workbenchCodeMirrorAutocompleteTheme'
import {
  WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS,
  WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorCompletionPresentation'
import { getWorkbenchJetBrainsFileIcon } from '../src/renderer/src/models/workbenchJetBrainsIcons'
import type { WorkbenchThemeId } from '../src/renderer/src/models/workbenchPreferences'

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
    /max-height: min\(calc\(\(var\(--workbench-editor-line-height, 20\.25px\) \+ 4px\) \* 10 \+ 8px\), 44vh\)/u
  )
})

void test('completion selection uses the live theme background without a left stroke', () => {
  const light = autocompleteThemeRules('light-modern')
  const dark = autocompleteThemeRules('dark-modern')

  for (const rules of [light, dark]) {
    assert.match(rules, /var\(--workbench-theme-color\)/u)
    assert.match(rules, /var\(--workbench-editor-tooltip-bg, var\(--workbench-bg\)\)/u)
    const selection = rules.match(/\[role="option"\]\[aria-selected="true"\] \{([^}]+)\}/u)?.[1] ?? ''
    assert.match(selection, /background-color: color-mix\(/u)
    assert.doesNotMatch(selection, /box-shadow:|border-left:/u)
  }
  assert.match(light, /var\(--workbench-theme-color\) 14%/u)
  assert.match(dark, /var\(--workbench-theme-color\) 22%/u)
})

void test('completion kinds use semantic icons instead of letter badges', () => {
  const rules = autocompleteThemeRules('light-modern')

  assert.match(rules, /cm-completionIcon::after[^}]*content: none/u)
  for (const kind of ['function', 'keyword', 'class', 'variable', 'snippet', 'folder', 'parameter']) {
    assert.match(rules, new RegExp(`cm-completionIcon-${kind}[^}]*background-image: url`, 'u'))
  }
  assert.match(rules, /cm-completionIcon-method[^}]*node-method\.svg/u)
  assert.match(autocompleteThemeRules('dark-modern'), /cm-completionIcon-method[^}]*node-method_dark\.svg/u)
})

void test('file tree uses JetBrains icons for explicit mappings and Workbench icons elsewhere', () => {
  assert.equal(getWorkbenchJetBrainsFileIcon('App.vue', 'vue'), 'file-vue')
  assert.equal(getWorkbenchJetBrainsFileIcon('setup.bat', 'text'), 'file-microsoftWindows')
  assert.equal(getWorkbenchJetBrainsFileIcon('project.toml', 'config'), 'file-toml')
  assert.equal(getWorkbenchJetBrainsFileIcon('Dockerfile', 'generic'), 'file-docker')
  for (const [file, variant] of [
    ['README.md', 'markdown'], ['sample.txt', 'text'], ['sample.png', 'image'],
    ['sample.zip', 'archive'], ['sample.yaml', 'yaml'], ['sample.ini', 'config'],
    ['.gitignore', 'gitignore'], ['package-lock.json', 'lock'], ['sample.patch', 'patch'],
    ['sample.csv', 'csv'], ['sample.xlsx', 'spreadsheet'],
    ['main.go', 'go'], ['main.rs', 'rust'], ['Main.kt', 'kotlin'], ['main.dart', 'dart'],
    ['script.vel', 'velarscript'], ['shader.glsl', 'glsl'], ['script.rb', 'code'],
    ['report.pdf', 'pdf'], ['document.docx', 'document'], ['slides.pptx', 'presentation'],
    ['sound.mp3', 'audio'], ['video.mp4', 'video'], ['sample.unknown', 'generic'],
    ['constructor', 'constructor'], ['unknown', null],
  ] as const) {
    assert.equal(getWorkbenchJetBrainsFileIcon(file, variant), null, file)
  }
})

void test('JavaScript, TypeScript, JSX, TSX and JSON keep their Workbench file icons', () => {
  for (const [file, variant] of [
    ['main.js', 'javascript'], ['build.mjs', 'javascript'], ['config.cjs', 'javascript'],
    ['main.jsx', 'jsx'], ['main.tsx', 'tsx'], ['main.ts', 'typescript'],
    ['types.mts', 'typescript'], ['types.cts', 'typescript'], ['package.json', 'json'],
    ['tsconfig.jsonc', 'json'],
  ] as const) {
    assert.equal(getWorkbenchJetBrainsFileIcon(file, variant), null, file)
  }
})

void test('completion starts promptly while language results update asynchronously', () => {
  assert.equal(WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS, 200)
  assert.ok(WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS <= 50)
})
