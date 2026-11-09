import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import { ensureSyntaxTree, highlightingFor } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { describe, mock, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'

import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'
import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import { withWorkbenchMarkdownLanguageService } from '../src/main/workspace/language/MarkdownLanguageService'
import { resolveWorkbenchCodeMirrorLanguage } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguage'
import {
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchInlayHintLanguageService,
  usesWorkbenchSemanticLanguageService,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import { getWorkbenchCodeMirrorTheme } from '../src/renderer/src/models/editor/workbenchCodeMirrorTheme'
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

  void test('colors Markdown code and mounts the fenced language parser', () => {
    const fence = String.fromCharCode(96).repeat(3)
    const content = `${fence}ts\nconst value: string = "ok"\n${fence}`
    const language = resolveWorkbenchCodeMirrorLanguage('README.md', '')
    const state = EditorState.create({
      doc: content,
      extensions: [language.extension, getWorkbenchCodeMirrorTheme('light-modern')],
    })

    const tree = ensureSyntaxTree(state, state.doc.length)
    assert.ok(tree, 'expected Markdown and its fenced TypeScript parser to finish')
    assert.equal(tree.resolveInner(content.indexOf('const') + 1, 1).name, 'const')
    assert.equal(tree.resolveInner(content.indexOf('value') + 1, 1).name, 'VariableDefinition')
    assert.equal(tree.resolveInner(content.indexOf('string') + 1, 1).name, 'TypeName')

    const codeClass = highlightingFor(state, [tags.monospace])
    assert.ok(codeClass)
    const rules = state
      .facet(EditorView.styleModule)
      .flatMap((module) => module.getRules())
      .join('\n')
    assert.ok(rules.includes(`.${codeClass} {color: #a04b00;}`))
  })

  void test('provides Markdown symbols, definitions, and broken-link diagnostics', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-markdown-'))
    const services = new WorkbenchLanguageServices(languagePathResolver, new ExternalLspProcessHost())
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

  void test('cancels a Markdown SDK read without detached rejections or early disposal', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-markdown-cancel-'))
    const guidePath = join(projectRoot, 'guide.md')
    const readme = '[Install guide](guide.md#install)'
    const originalFs = { ...(await import('node:fs/promises')) }
    const originalSdk = { ...(await import('vscode-markdown-languageservice')) }
    let enterRead!: () => void
    let releaseRead!: () => void
    const readEntered = new Promise<void>((resolve) => {
      enterRead = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const controller = new AbortController()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    let guideReads = 0
    let readSignal: unknown
    let disposed = false
    let runSettled = false
    let disposedBeforeRunSettled = false
    let settled = false
    const sdkFailure = new Error('Markdown request failed after its read settled')
    const createLanguageService: typeof originalSdk.createLanguageService = (options) => {
      const service = originalSdk.createLanguageService(options)
      return {
        ...service,
        dispose() {
          disposedBeforeRunSettled = !runSettled
          disposed = true
          service.dispose()
        },
      }
    }
    const gatedReadFile = (async (...args: Parameters<typeof readFile>) => {
      const content = await originalFs.readFile(...args)
      const isGuide =
        typeof args[0] === 'string' &&
        (process.platform === 'win32'
          ? args[0].toLowerCase() === guidePath.toLowerCase()
          : args[0] === guidePath)
      if (isGuide) {
        guideReads += 1
        readSignal = typeof args[1] === 'object' && args[1] ? args[1].signal : undefined
        enterRead()
        await readGate
      }
      return content
    }) as typeof readFile

    process.on('unhandledRejection', onUnhandled)
    try {
      await writeFile(guidePath, '# Install\n', 'utf8')
      void mock.module('vscode-markdown-languageservice', () => ({
        ...originalSdk,
        createLanguageService,
      }))
      void mock.module('node:fs/promises', () => ({ ...originalFs, readFile: gatedReadFile }))
      assert.equal((await import('node:fs/promises')).readFile, gatedReadFile)
      assert.equal(
        (await import('vscode-markdown-languageservice')).createLanguageService,
        createLanguageService
      )
      const pending = withWorkbenchMarkdownLanguageService(
        {
          projectRoot,
          absolutePath: join(projectRoot, 'README.md'),
          content: readme,
          signal: controller.signal,
        },
        async ({ service, document, token }) => {
          try {
            await service.getDefinition(document, { line: 0, character: 19 }, token)
            // Also exercise cancellation normalization when the request callback rejects.
            throw sdkFailure
          } finally {
            runSettled = true
          }
        }
      )
      const observed = pending.then(
        (value) => {
          settled = true
          return { ok: true as const, value }
        },
        (error: unknown) => {
          settled = true
          return { ok: false as const, error }
        }
      )
      try {
        await readEntered
        assert.equal(readSignal, controller.signal)
        controller.abort()
        await Promise.resolve()
        assert.equal(settled, false, 'cancellation must await the in-flight SDK callback')
        assert.equal(disposed, false)
        releaseRead()
        const outcome = await observed
        assert.ok(!outcome.ok)
        assert.ok(outcome.error instanceof AppError)
        assert.equal(outcome.error.code, 'CANCELLED')
        assert.notEqual(outcome.error, sdkFailure)
        assert.equal(disposed, true)
        assert.equal(disposedBeforeRunSettled, false)
      } finally {
        releaseRead()
        await observed
      }

      const overlayReadme = '[Install guide](guide.md#overlay-install)'
      const definition = await withWorkbenchMarkdownLanguageService(
        {
          projectRoot,
          absolutePath: join(projectRoot, 'README.md'),
          content: overlayReadme,
          openFiles: [{ absolutePath: guidePath, content: '# Overlay install\n' }],
        },
        ({ service, document, token }) =>
          service.getDefinition(document, { line: 0, character: 19 }, token)
      )
      const location = Array.isArray(definition) ? definition[0] : definition
      assert.ok(location && 'uri' in location)
      assert.equal(location.range.start.line, 0)
      assert.equal(guideReads, 1, 'the next request must use its unsaved overlay')
      await setImmediate()
      assert.deepEqual(unhandled, [])
    } finally {
      releaseRead()
      void mock.module('vscode-markdown-languageservice', () => originalSdk)
      void mock.module('node:fs/promises', () => originalFs)
      process.off('unhandledRejection', onUnhandled)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
