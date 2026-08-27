import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, test } from 'node:test'

import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import {
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchInlayHintLanguageService,
  usesWorkbenchSemanticLanguageService,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import {
  isWorkbenchMarkdownPreviewPath,
  resolveWorkbenchMarkdownLink,
} from '../src/renderer/src/models/editor/workbenchMarkdownPreview'

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

const languagePathResolver = {
  async resolveProjectRoot(input: string): Promise<string> {
    const root = await realpath(resolve(input))
    if (!(await stat(root)).isDirectory()) throw new Error('Expected a project directory')
    return root
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Path escapes project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    if (!isInside(projectRoot, absolutePath)) throw new Error('Path escapes project')
    return relative(projectRoot, absolutePath).replaceAll('\\', '/') || '.'
  },
}

void describe('Workbench Markdown support', () => {
  void test('enables Markdown semantics without requesting unsupported inlay hints', () => {
    assert.equal(usesWorkbenchBuiltinLanguageService('README.md'), true)
    assert.equal(usesWorkbenchSemanticLanguageService('README.md'), true)
    assert.equal(usesWorkbenchInlayHintLanguageService('README.md'), false)
    assert.equal(isWorkbenchMarkdownPreviewPath('docs/guide.markdown'), true)
    assert.equal(isWorkbenchMarkdownPreviewPath('docs/component.mdx'), false)
  })

  void test('keeps preview navigation inside the project and blocks dangerous schemes', () => {
    assert.deepEqual(resolveWorkbenchMarkdownLink('docs/guide.md', '../README.md#start'), {
      kind: 'project',
      path: 'README.md',
      fragment: 'start',
    })
    assert.deepEqual(resolveWorkbenchMarkdownLink('docs/guide.md', 'https://velaros.ai'), {
      kind: 'external',
      url: 'https://velaros.ai',
    })
    assert.deepEqual(resolveWorkbenchMarkdownLink('docs/guide.md', '#usage'), {
      kind: 'fragment',
      fragment: 'usage',
    })
    assert.deepEqual(resolveWorkbenchMarkdownLink('docs/guide.md', '../../secret.md'), {
      kind: 'blocked',
    })
    assert.deepEqual(resolveWorkbenchMarkdownLink('docs/guide.md', 'javascript:alert(1)'), {
      kind: 'blocked',
    })
  })

  void test('keeps project links clickable and renders document blocks without chat chrome', async () => {
    const root = resolve(import.meta.dir, '..')
    const [previewSource, editorStyles] = await Promise.all([
      readFile(join(root, 'src/renderer/src/components/editor/WorkbenchMarkdownPreview.tsx'), 'utf8'),
      readFile(join(root, 'src/renderer/src/styles/09-editor.module.css'), 'utf8'),
    ])

    assert.match(previewSource, /name !== 'harden'/u)
    assert.match(previewSource, /rehypePlugins=\{WORKBENCH_MARKDOWN_REHYPE_PLUGINS\}/u)
    assert.match(previewSource, /controls=\{false\}/u)
    assert.match(
      editorStyles,
      /\[data-streamdown='table-wrapper'\][\s\S]*?display:\s*contents/u
    )
    assert.match(editorStyles, /\[data-streamdown='code-block-header'\][\s\S]*?display:\s*none/u)
  })

  void test('provides Markdown symbols, definitions, and broken-link diagnostics', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-markdown-'))
    const services = new WorkbenchLanguageServices(languagePathResolver)
    const guide = '# Install\n\nRun the installer.\n'
    const readme = [
      '# Workbench',
      '',
      '[Install guide](guide.md#install)',
      '',
      '[Missing guide](missing.md)',
      '',
    ].join('\n')

    try {
      await writeFile(join(projectRoot, 'guide.md'), guide, 'utf8')
      await writeFile(join(projectRoot, 'README.md'), readme, 'utf8')

      const resolved = await services.resolveLanguageService({
        projectRoot,
        path: 'README.md',
        content: readme,
      })
      assert.equal(resolved.service?.runtime, 'markdown-language-service')
      assert.ok(resolved.capabilities.includes('definition'))
      assert.ok(resolved.capabilities.includes('diagnostics'))
      assert.ok(resolved.capabilities.includes('document-symbols'))

      const symbols = await services.getDocumentSymbols({
        projectRoot,
        path: 'README.md',
        content: readme,
      })
      assert.equal(symbols.symbols[0]?.name, 'Workbench')

      const diagnostics = await services.getDiagnostics({
        projectRoot,
        path: 'README.md',
        content: readme,
      })
      assert.ok(diagnostics.diagnostics.some((diagnostic) =>
        diagnostic.message.toLowerCase().includes('missing.md')
      ))

      const definition = await services.getDefinition({
        projectRoot,
        path: 'README.md',
        content: readme,
        position: { line: 3, column: 19 },
      })
      assert.equal(definition.locations[0]?.path, 'guide.md')
      assert.equal(definition.locations[0]?.line, 1)
    } finally {
      await services.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
