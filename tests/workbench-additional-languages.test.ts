import assert from 'node:assert/strict'

import { ensureSyntaxTree, HighlightStyle } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { test } from 'bun:test'

import { resolveWorkbenchCodeMirrorLanguage } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguage'
import { usesWorkbenchExternalLspLanguageService } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import { getWorkbenchCodeHighlightSpecs } from '../src/renderer/src/models/editor/workbenchCodeMirrorTheme'
import { resolveWorkbenchFilePresentation } from '../src/renderer/src/models/files/workbenchFilePresentation'
import { fileLanguage } from '../src/renderer/src/models/shared/workbenchUtils'
import { resolveBuiltinWorkbenchLanguageService } from '../src/shared/workbenchLanguageServices'

const samples = [
  ['Hello.java', 'Java', 'java', 'public class Hello { String name = "world"; }'],
  ['Hello.cs', 'C#', 'csharp', 'public class Hello { string name = "world"; }'],
  ['main.go', 'Go', 'go', 'package main\nfunc main() { println("hello") }'],
  ['main.rs', 'Rust', 'rust', 'fn main() { let name = "hello"; }'],
  [
    'App.vue',
    'Vue',
    'vue',
    '<script setup lang="ts">\nconst name: string = "hello"\n</script>\n<template><h1>{{ name }}</h1></template>',
  ],
  ['main.dart', 'Dart', 'dart', 'void main() { final name = "hello"; }'],
  ['main.swift', 'Swift', 'swift', 'func hello() { let name = "hello" }'],
  ['main.kt', 'Kotlin', 'kotlin', 'fun main() { val name = "hello" }'],
  [
    'module.wat',
    'WebAssembly',
    'webassembly',
    '(module (func (export "main") (result i32) i32.const 42))',
  ],
  ['shader.frag', 'GLSL', 'glsl', 'uniform vec4 color;\nvoid main() { gl_FragColor = color; }'],
] as const

const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'keyword' },
  { tag: tags.string, class: 'string' },
  { tag: tags.typeName, class: 'type' },
  { tag: tags.tagName, class: 'tag' },
  { tag: tags.variableName, class: 'variable' },
])

for (const [path, label, service, content] of samples) {
  test(`${label} files have syntax, file identity and semantic-service routing`, () => {
    const support = resolveWorkbenchCodeMirrorLanguage(path, '')
    assert.equal(support.mode, 'builtin')
    assert.equal(fileLanguage(path), label)
    const state = EditorState.create({ doc: content, extensions: support.extension })
    const tree = ensureSyntaxTree(state, content.length, 1_000)
    assert.ok(tree)
    const highlighted: string[] = []
    highlightTree(tree, highlighter, (from, to) => highlighted.push(content.slice(from, to)))
    assert.ok(highlighted.length > 0, `${label} should have real syntax tokens`)
    assert.equal(resolveBuiltinWorkbenchLanguageService(path.split('.').at(-1)!)?.id, service)
    assert.equal(usesWorkbenchExternalLspLanguageService(path), true)
    const presentation = resolveWorkbenchFilePresentation({ fileName: path })
    assert.equal(presentation.variant, service)
    assert.match(presentation.color ?? '', /^#[\da-f]{6}$/iu)
  })
}

test('language modifiers use the keyword color in every editor theme', () => {
  for (const theme of ['light-modern', 'warm-paper', 'dark-modern', 'midnight-blue'] as const) {
    const style = HighlightStyle.define([...getWorkbenchCodeHighlightSpecs(theme)])
    assert.ok(style.style([tags.modifier]), `${theme}: modifiers must have a color`)
    assert.equal(style.style([tags.modifier]), style.style([tags.keyword]))
  }
})

for (const [path, content] of [
  ['app.less', '@color: red; .app { color: @color; &:hover { color: blue; } }'],
  ['app.scss', '$color: red; .app { color: $color; &:hover { color: blue; } }'],
  ['app.sass', '$color: red\n.app\n  color: $color\n  &:hover\n    color: blue\n'],
]) {
  test(`${path} parses its own stylesheet syntax without errors`, () => {
    const support = resolveWorkbenchCodeMirrorLanguage(path!, '')
    const state = EditorState.create({ doc: content, extensions: support.extension })
    const tree = ensureSyntaxTree(state, state.doc.length, 1_000)
    assert.ok(tree)
    const errors: number[] = []
    tree.iterate({
      enter: (node) => {
        if (node.type.isError) errors.push(node.from)
      },
    })
    assert.deepEqual(errors, [])
  })
}

test('all shader stages, scripts, WebAssembly text and code fences have language aliases', () => {
  for (const extension of [
    'kt',
    'kts',
    'cs',
    'csx',
    'wat',
    'wast',
    'glsl',
    'vert',
    'frag',
    'geom',
    'tesc',
    'tese',
    'comp',
    'vsh',
    'fsh',
  ])
    assert.equal(resolveWorkbenchCodeMirrorLanguage(`src/example.${extension}`, '').mode, 'builtin')
  for (const token of [
    'java',
    'csharp',
    'c#',
    'golang',
    'rust',
    'vue',
    'dart',
    'swift',
    'kotlin',
    'wasm',
    'glsl',
    'less',
    'sass',
    'scss',
  ])
    assert.equal(resolveWorkbenchCodeMirrorLanguage(null, token).mode, 'builtin')
  for (const token of ['c', 'cpp', 'c++', 'wasm'])
    assert.equal(resolveBuiltinWorkbenchLanguageService(token), null)
  assert.equal(resolveWorkbenchCodeMirrorLanguage('module.wasm', '').mode, 'plain-text')
})
