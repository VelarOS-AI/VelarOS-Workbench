import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EditorState } from '@codemirror/state'

import { ExternalLspClient } from '../src/main/workspace/language/ExternalLspClient'
import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import { PathResolver } from '../src/main/workspace/PathResolver'
import {
  VELAR_EDITOR_KEYWORDS,
  VelarWorkbenchEditorLanguage,
} from '../src/renderer/src/contributions/velar/editor'
import {
  registerWorkbenchEditorLanguage,
  resolveInjectedWorkbenchProjectLanguages,
} from '../src/renderer/src/language/workbenchEditorLanguageContributions'
import { buildWorkbenchBasicKeywordDecorations } from '../src/renderer/src/models/editor/workbenchCodeMirrorBasicSyntax'
import { resolveWorkbenchCodeMirrorLanguage } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguage'
import {
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchSemanticLanguageService,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import {
  VELAR_LANGUAGE_SERVER_PROTOCOL_VERSION,
  VelarWorkbenchLanguageService,
} from '../src/shared/contributions/velar/service'
import {
  getBuiltinWorkbenchLanguageServices,
  registerWorkbenchLanguageService,
  resolveBuiltinWorkbenchLanguageService,
} from '../src/shared/language/workbenchLanguageServices'

function installVelarWorkbenchContribution(): () => void {
  const removeEditor = registerWorkbenchEditorLanguage(VelarWorkbenchEditorLanguage)
  const removeService = registerWorkbenchLanguageService(VelarWorkbenchLanguageService)
  return () => {
    removeEditor()
    removeService()
  }
}

void describe('focused Workbench language surface', () => {
  void test('keeps the generic editor host free of Velar-specific branches', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const genericFiles = [
      'src/shared/language/workbenchLanguageServices.ts',
      'src/renderer/src/models/editor/workbenchCodeMirrorLanguage.ts',
      'src/main/workspace/language/ExternalLspClient.ts',
    ]
    for (const relativePath of genericFiles) {
      const source = await readFile(join(root, relativePath), 'utf8')
      assert.doesNotMatch(source, /velarscript|workbenchVelar|VelarTokens|experimental\?\.\['velar'\]/u)
    }

    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    assert.equal(
      Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith('@velarscript/')),
      false
    )
  })

  void test('keeps Velar outside the generic host until its built-in contribution is injected', () => {
    assert.deepEqual(
      getBuiltinWorkbenchLanguageServices().map((service) => service.id),
      ['typescript-javascript', 'python', 'web-html', 'web-css']
    )
    assert.equal(resolveBuiltinWorkbenchLanguageService('vel'), null)
    assert.equal(resolveWorkbenchCodeMirrorLanguage('src/main.vel', '').mode, 'plain-text')

    const remove = installVelarWorkbenchContribution()
    assert.deepEqual(
      getBuiltinWorkbenchLanguageServices().map((service) => service.id),
      ['typescript-javascript', 'python', 'web-html', 'web-css', 'velarscript']
    )
    remove()
    for (const language of ['java', 'cpp', 'go', 'rust'])
      assert.equal(resolveBuiltinWorkbenchLanguageService(language), null)
  })

  void test('loads VelarScript syntax as a built-in language', () => {
    const remove = installVelarWorkbenchContribution()
    const velar = resolveWorkbenchCodeMirrorLanguage('src/main.vel', '')
    assert.equal(velar.mode, 'builtin')
    assert.equal(velar.languageId, 'velar')
    assert.equal(usesWorkbenchBuiltinLanguageService('src/main.vel'), true)
    assert.equal(usesWorkbenchSemanticLanguageService('src/main.vel'), true)
    assert.equal(usesWorkbenchBuiltinLanguageService('src/main.py'), true)
    assert.equal(resolveWorkbenchCodeMirrorLanguage('src/main.go', '').mode, 'plain-text')
    const state = EditorState.create({ doc: 'const value = 1\n', extensions: [velar.extension] })
    assert.deepEqual(state.languageDataAt<{ line: string }>('commentTokens', 0), [{ line: '//' }])
    for (const keyword of [
      'abstract',
      'case',
      'enum',
      'extends',
      'extern',
      'global',
      'is',
      'js',
      'module',
      'match',
      'override',
      'pass',
      'resource',
      'static',
      'super',
      'throw',
      'unsafe',
    ])
      assert.ok(VELAR_EDITOR_KEYWORDS.includes(keyword as typeof VELAR_EDITOR_KEYWORDS[number]))

    const decorations = buildWorkbenchBasicKeywordDecorations(
      EditorState.create({ doc: '# unsafe\n// extern\nmodule value\n' }).doc,
      [{ from: 0, to: 32 }],
      'velar'
    )
    const ranges: Array<{ from: number; to: number }> = []
    decorations.between(0, 32, (from, to) => ranges.push({ from, to }))
    assert.deepEqual(ranges, [{ from: 2, to: 8 }, { from: 19, to: 25 }])

    const pythonDoc = EditorState.create({ doc: 'value = 1 # if\nif True:\n' }).doc
    const pythonDecorations = buildWorkbenchBasicKeywordDecorations(
      pythonDoc,
      [{ from: 0, to: pythonDoc.length }],
      'python'
    )
    const pythonRanges: Array<{ from: number; to: number }> = []
    pythonDecorations.between(0, pythonDoc.length, (from, to) =>
      pythonRanges.push({ from, to })
    )
    assert.deepEqual(pythonRanges, [{ from: 15, to: 17 }, { from: 18, to: 22 }])
    remove()
  })

  void test('keeps the Velar language protocol versioned', () => {
    const remove = installVelarWorkbenchContribution()
    const velar = resolveBuiltinWorkbenchLanguageService('vel')
    assert.equal(velar?.protocol?.version, VELAR_LANGUAGE_SERVER_PROTOCOL_VERSION)
    assert.equal(VELAR_LANGUAGE_SERVER_PROTOCOL_VERSION, 1)
    remove()
  })

  void test('injects Velar project detection and generic project commands', () => {
    assert.deepEqual(resolveInjectedWorkbenchProjectLanguages(['package.json']), [])
    const remove = installVelarWorkbenchContribution()
    const [velar] = resolveInjectedWorkbenchProjectLanguages(['src', 'velar.json'])
    assert.equal(velar?.id, 'velarscript')
    assert.deepEqual(velar?.project?.commands.map((command) => command.id), [
      'check',
      'dev',
      'test',
      'test-browser',
      'build',
      'verify',
      'preview',
      'verify-deployment',
      'upgrade-check',
    ])
    remove()
  })
})

void describe('shared external LSP client', () => {
  void test('maps the shared semantic LSP surface over stdio', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    const client = new ExternalLspClient(projectRoot, {
      id: 'velarscript',
      label: 'VelarScript',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['vel'],
      languages: ['velar'],
      command: process.execPath,
      args: [fixture],
      documentLanguageId: 'velar',
      protocol: {
        capabilityPath: ['capabilities', 'experimental', 'velar', 'protocolVersion'],
        version: 1,
      },
    })
    const path = `${projectRoot}/tests/fixture.vel`

    const diagnostics = await client.getDiagnostics(path, 'component App:\n')
    const completions = await client.completion(path, 'comp', { line: 0, character: 4 })
    const hover = await client.hover(path, 'component App:\n', { line: 0, character: 2 })
    const definitions = await client.definition(path, 'component App:\n', { line: 0, character: 11 })
    const references = await client.references(path, 'component App:\n', { line: 0, character: 11 })
    const rename = await client.rename(path, 'component App:\n', { line: 0, character: 11 }, 'Shell')
    const symbols = await client.documentSymbols(path, 'component App:\n')
    const signature = await client.signatureHelp(path, 'mount(', { line: 0, character: 6 })
    const edits = await client.format(path, 'component App:\n')

    assert.deepEqual(diagnostics.map((item) => item.code), ['VEL5001'])
    assert.equal(completions[0]?.label, 'component')
    assert.deepEqual(hover?.contents, { kind: 'markdown', value: 'Velar hover' })
    assert.equal(definitions[0]?.range.start.character, 10)
    assert.equal(references[0]?.range.start.line, 1)
    assert.equal(rename.changes?.[definitions[0]?.uri ?? '']?.[0]?.newText, 'Shell')
    assert.equal(symbols[0]?.name, 'App')
    assert.equal(signature?.signatures[0]?.label, 'mount(node, target) -> none')
    assert.equal(edits[0]?.newText, 'component App:\n')
    await client.dispose()
  })

  void test('routes an injected LSP through generic Workbench semantic contracts', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-external-lsp-'))
    const remove = registerWorkbenchLanguageService({
      id: 'fixture-language',
      label: 'Fixture Language',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['fakevel'],
      languages: ['fixture-language'],
      command: process.execPath,
      args: [fixture],
      documentLanguageId: 'fixture-language',
    })
    const services = new WorkbenchLanguageServices(new PathResolver())
    const request = {
      projectRoot,
      path: 'main.fakevel',
      content: 'component App:\n',
      position: { line: 1, column: 11 },
    }

    const resolved = await services.resolveLanguageService(request)
    const definition = await services.getDefinition(request)
    const references = await services.getReferences(request)
    const rename = await services.getRename({ ...request, newName: 'Shell' })
    const signatures = await services.getSignatureHelp(request)
    const symbols = await services.getDocumentSymbols(request)

    assert.ok(resolved.capabilities.includes('definition'))
    assert.ok(resolved.capabilities.includes('rename'))
    assert.equal(definition.locations[0]?.path, 'main.fakevel')
    assert.equal(references.locations[0]?.line, 2)
    assert.equal(rename.changes[0]?.edits[0]?.newText, 'Shell')
    assert.equal(signatures.signatureHelp?.signatures[0]?.parameters[0]?.label, 'node')
    assert.equal(symbols.symbols[0]?.kind, 'class')

    await services.dispose()
    remove()
  })

  void test('preserves string diagnostic codes and explains missing toolchains', async () => {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    const missing = new ExternalLspClient(projectRoot, {
      id: 'velarscript',
      label: 'VelarScript',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['vel'],
      languages: ['velar'],
      packageName: '@velarscript/cli',
      command: '__velar_missing_language_server__',
      args: ['lsp'],
      documentLanguageId: 'velar',
      protocol: {
        capabilityPath: ['capabilities', 'experimental', 'velar', 'protocolVersion'],
        version: 1,
      },
    })

    await assert.rejects(
      missing.getDiagnostics(`${projectRoot}/tests/missing.vel`, 'const value = 1\n'),
      /未找到 '__velar_missing_language_server__'.*@velarscript\/cli/u
    )
    await missing.dispose()
  })

  void test('starts the Workbench-owned Pyright runtime', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-pyright-'))
    const services = new WorkbenchLanguageServices(new PathResolver())
    const path = 'pyright-runtime-probe.py'
    const content = 'message: str = 42\n'

    const diagnostics = await services.getDiagnostics({ projectRoot, path, content })
    const hover = await services.getHover({
      projectRoot,
      path,
      content,
      position: { line: 1, column: 2 },
    })

    assert.ok(diagnostics.diagnostics.some((item) =>
      item.code === 'reportAssignmentType'
      && /not assignable to declared type "str"/iu.test(item.message)
    ))
    assert.match(JSON.stringify(hover), /str/u)
    await services.dispose()
  })
})
