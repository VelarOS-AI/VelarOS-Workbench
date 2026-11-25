import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { createLanguageProject, positionOf } from './helpers/languageProject'

test('TypeScript diagnostics distinguish existing Vue imports from missing modules', async () => {
  const path = 'src/router.ts'
  const content = [
    'export const relative = () => import("./views/LoginView.vue")',
    'export const alias = () => import("@/views/LoginView.vue")',
    'export const missingVue = () => import("@/views/MissingView.vue")',
    'export const missingTs = () => import("./missing")',
    'export const count: number = "wrong"',
  ].join('\n')
  const project = await createLanguageProject({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src'],
    }),
    [path]: content,
    'src/views/LoginView.vue': '<template><main>Log in</main></template>',
  })
  try {
    const request = { projectRoot: project.projectRoot, path, content }
    const editor = await project.services.getDiagnostics(request)
    const workspace = await project.services.getProjectDiagnostics({
      projectRoot: project.projectRoot,
      anchorPaths: [path],
    })
    for (const { diagnostics } of [editor, workspace]) {
      const errors = diagnostics.filter((item) => item.severity === 'error')
      assert.deepEqual(errors.map(({ code, range }) => [code, range.startLine]), [
        [2307, 3],
        [2307, 4],
        [2322, 5],
      ])
    }

    await project.write('src/views/MissingView.vue', '<template><main>New view</main></template>')
    const refreshed = await project.services.getDiagnostics(request)
    assert.deepEqual(
      refreshed.diagnostics.filter((item) => item.severity === 'error').map(({ code }) => code),
      [2307, 2322]
    )
  } finally {
    await project.dispose()
  }
})

test('bundled Vue server checks TypeScript in SFCs and supplies completions without project-installed servers', async () => {
  const content =
    '<script setup lang="ts">\nconst count: number = "wrong"\nconst message = "hello"\nmessage.toUpperCase()\nfunction formatDate(value: Date): string { return value.toISOString() }\nconst values = Array.from(new Map([["a", new Date()]]).values()).map(formatDate)\n</script>\n<template><div>{{ message }} {{ values }}</div></template>\n'
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
    assert.ok(
      !diagnostics.diagnostics.some((item) =>
        /Cannot find name '(?:Array|Date|Map)'/.test(item.message)
      ),
      JSON.stringify(diagnostics)
    )
    const hover = await project.services.getHover({
      ...request,
      position: positionOf(content, 'formatDate', 2),
    })
    assert.match(hover.hover?.displayText ?? '', /formatDate/)
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
