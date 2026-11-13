import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileCodeIcon } from '@phosphor-icons/react'
import { describe, test } from 'bun:test'

import { WorkbenchFileTypeIcon } from '../src/renderer/src/components/files/WorkbenchFileTypeIcon'
import {
  getWorkbenchFilePresentationVariant,
  registerWorkbenchFileIconContribution,
  resolveWorkbenchFilePresentation,
} from '../src/renderer/src/models/files/workbenchFilePresentation'

void describe('Workbench file icon surface', () => {
  void test('uses product icons for current languages and common project files', () => {
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: '.gitignore' }), 'gitignore')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: '.npmrc' }), 'config')
    // JSON 写的配置用 JSON 图标，不显示成 INI。
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'tsconfig.json' }), 'json')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: '.eslintrc.json' }), 'json')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'pom.xml' }), 'code')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'bun.lock' }), 'lock')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'package.json' }), 'json')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'change.patch' }), 'patch')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'styles/app.css' }), 'css')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'styles/APP.CSS' }), 'css')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'styles/app.module.css' }), 'css')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'styles/app.less' }), 'less')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'styles/app.sass' }), 'sass')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'styles/app.scss' }), 'scss')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.js' }), 'javascript')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'view.jsx' }), 'jsx')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.ts' }), 'typescript')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'view.tsx' }), 'tsx')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.vel' }), 'velarscript')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'catalog.yml' }), 'yaml')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'schema.yaml' }), 'yaml')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'electron-builder.yml' }), 'yaml')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'settings.ini' }), 'config')
  })

  void test('renders stylesheet files with the shared CSS file icon', () => {
    for (const [fileName, variant, color] of [
      ['styles/app.css', 'css', '--workbench-file-css'],
      ['styles/app.less', 'less', '--workbench-file-css'],
      ['styles/app.sass', 'sass', '--workbench-file-scss'],
      ['styles/app.scss', 'scss', '--workbench-file-scss'],
    ] as const) {
      const markup = renderToStaticMarkup(
        createElement(WorkbenchFileTypeIcon, {
          fileName,
          size: 16,
        })
      )

      assert.match(markup, new RegExp(`data-file-icon-kind="${variant}"`, 'u'))
      assert.match(markup, new RegExp(`var\\(${color}\\)`, 'u'))
      assert.match(markup, /<svg\b/u)
    }
  })

  void test('routes every file-bearing Workbench surface through the shared icon resolver', () => {
    for (const relativePath of [
      'src/renderer/src/components/files/FileTreeRow.tsx',
      'src/renderer/src/components/files/FileSearchResults.tsx',
      'src/renderer/src/components/QuickOpen.tsx',
      'src/renderer/src/components/editor/EditorTabBar.tsx',
      'src/renderer/src/components/editor/EditorBreadcrumbBar.tsx',
      'src/renderer/src/components/chrome/StatusBar.tsx',
      'src/renderer/src/components/git/GitDiffEditorPanel.tsx',
      'src/renderer/src/components/git/WorkbenchCommitPanel.tsx',
    ]) {
      const source = readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
      assert.match(source, /<WorkbenchFileTypeIcon\b/u, relativePath)
    }
  })

  void test('lets registered contributions override the built-in language icons', () => {
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'App.vue' }), 'vue')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.py' }), 'python')

    const contribution = {
      id: 'fixture-framework-icons',
      resolve: ({ fileName }: { fileName?: string | null }) =>
        fileName?.endsWith('.vue')
          ? { variant: 'fixture-vue', icon: FileCodeIcon, color: '#42b883' }
          : null,
    }
    const remove = registerWorkbenchFileIconContribution(contribution)
    try {
      assert.deepEqual(resolveWorkbenchFilePresentation({ fileName: 'App.vue' }), {
        variant: 'fixture-vue',
        icon: FileCodeIcon,
        color: '#42b883',
      })
    } finally {
      remove()
    }

    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'App.vue' }), 'vue')
  })

  void test('renders distinct colored icons for supported programming languages', () => {
    const paths = [
      'Main.java',
      'Main.cs',
      'main.go',
      'main.rs',
      'App.vue',
      'main.dart',
      'main.swift',
      'main.kt',
      'module.wat',
      'shader.frag',
      'main.py',
      'index.html',
      'query.sql',
    ]
    const variants = new Set<string>()
    for (const fileName of paths) {
      const presentation = resolveWorkbenchFilePresentation({ fileName })
      variants.add(presentation.variant)
      const markup = renderToStaticMarkup(createElement(WorkbenchFileTypeIcon, { fileName }))
      assert.match(presentation.color ?? '', /^#[\da-f]{6}$/iu)
      assert.ok(markup.includes(presentation.color!), fileName)
      assert.match(markup, new RegExp(`data-file-icon-kind="${presentation.variant}"`, 'u'))
    }
    assert.equal(variants.size, paths.length)
  })
})
