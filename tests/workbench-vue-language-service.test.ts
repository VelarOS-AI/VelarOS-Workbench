import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { createLanguageProject, positionOf } from './helpers/languageProject'

test('bundled Vue server checks TypeScript in SFCs and supplies completions without project-installed servers', async () => {
  const content =
    '<script setup lang="ts">\nconst count: number = "wrong"\nconst message = "hello"\nmessage.toUpperCase()\n</script>\n<template><div>{{ message }}</div></template>\n'
  const project = await createLanguageProject({
    'package.json': JSON.stringify({ name: 'vue-language-fixture', private: true }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, target: 'ESNext' },
      include: ['*.vue'],
    }),
    'App.vue': content,
  })
  try {
    const request = { projectRoot: project.projectRoot, path: 'App.vue', content }
    const diagnostics = await project.services.getDiagnostics(request)
    assert.ok(
      diagnostics.diagnostics.some((item) => String(item.code) === '2322'),
      JSON.stringify(diagnostics)
    )
    const symbols = await project.services.getDocumentSymbols(request)
    assert.ok(symbols.symbols.length > 0)
    const completions = await project.services.getCompletions({
      ...request,
      position: positionOf(content, 'toUpperCase'),
    })
    assert.ok(
      completions.items.some((item) => item.label === 'toUpperCase'),
      JSON.stringify(completions)
    )
  } finally {
    await project.dispose()
  }
}, 30_000)
