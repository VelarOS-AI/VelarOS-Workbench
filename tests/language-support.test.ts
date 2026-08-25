import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'

import {
  ExternalLspClient,
  ExternalLspManager,
} from '../src/main/workspace/language/ExternalLspClient'
import {
  buildExternalDefinitionPreview,
  buildExternalHoverResult,
  WorkbenchLanguageServices,
} from '../src/main/workspace/language/LanguageServices'
import {
  resolveTypeScriptDefaultLibFilePath,
} from '../src/main/workspace/language/TypeScriptProjectHost'
import {
  VELAR_EDITOR_KEYWORDS,
  velarScript,
  VelarWorkbenchEditorLanguage,
} from '../src/renderer/src/contributions/velar/editor'
import {
  registerWorkbenchEditorLanguage,
  resolveInjectedWorkbenchProjectLanguages,
} from '../src/renderer/src/language/workbenchEditorLanguageContributions'
import { buildWorkbenchBasicKeywordDecorations } from '../src/renderer/src/models/editor/workbenchCodeMirrorBasicSyntax'
import { resolveWorkbenchCodeMirrorLanguage } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguage'
import {
  getWorkbenchHoverTokenRange,
  isWorkbenchTypeHover,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageFeatures'
import {
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchExternalLspLanguageService,
  usesWorkbenchExternalSemanticLanguageService,
  usesWorkbenchInlayHintLanguageService,
  usesWorkbenchSemanticLanguageService,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import { buildWorkbenchSemanticTokenDecorations } from '../src/renderer/src/models/editor/workbenchCodeMirrorSemanticTokens'
import { buildWorkbenchSemanticOccurrenceDecorations } from '../src/renderer/src/models/editor/workbenchCodeMirrorTokenOccurrenceHighlight'
import { fileLanguage } from '../src/renderer/src/models/shared/workbenchUtils'
import { VelarWorkbenchLanguageService } from '../src/shared/contributions/velar/service'
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

const languagePathResolver = {
  async resolveProjectRoot(input: string): Promise<string> {
    const root = await realpath(resolve(input))
    if (!(await stat(root)).isDirectory()) throw new Error('The language project root must be a directory')
    return root
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    const value = relative(projectRoot, absolutePath)
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${absolutePath}`)
    return (value || '.').replaceAll('\\', '/')
  },
}

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function languageRangeText(
  content: string,
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number }
): string {
  if (range.startLine !== range.endLine) return ''
  const line = content.split('\n')[range.startLine - 1] ?? ''
  return line.slice(range.startColumn - 1, range.endColumn - 1)
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
      ['typescript-javascript', 'python', 'web-html', 'web-css', 'markdown']
    )
    assert.equal(resolveBuiltinWorkbenchLanguageService('vel'), null)
    assert.equal(resolveWorkbenchCodeMirrorLanguage('src/main.vel', '').mode, 'plain-text')

    const remove = installVelarWorkbenchContribution()
    assert.deepEqual(
      getBuiltinWorkbenchLanguageServices().map((service) => service.id),
      ['typescript-javascript', 'python', 'web-html', 'web-css', 'markdown', 'velarscript']
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
    assert.equal(usesWorkbenchExternalLspLanguageService('src/main.vel'), true)
    assert.equal(usesWorkbenchExternalLspLanguageService('src/main.ts'), false)
    assert.equal(usesWorkbenchExternalSemanticLanguageService('src/main.vel'), true)
    assert.equal(usesWorkbenchExternalSemanticLanguageService('src/main.py'), true)
    assert.equal(usesWorkbenchExternalSemanticLanguageService('src/main.ts'), false)
    assert.equal(usesWorkbenchInlayHintLanguageService('src/main.vel'), true)
    assert.equal(usesWorkbenchInlayHintLanguageService('src/main.py'), true)
    assert.equal(usesWorkbenchInlayHintLanguageService('src/main.html'), false)
    assert.equal(usesWorkbenchBuiltinLanguageService('src/main.py'), true)
    assert.equal(resolveWorkbenchCodeMirrorLanguage('src/main.go', '').mode, 'plain-text')
    const state = EditorState.create({ doc: 'const value = 1\n', extensions: [velar.extension] })
    assert.deepEqual(state.languageDataAt<{ line: string }>('commentTokens', 0), [{ line: '//' }])
    const exactOccurrences = buildWorkbenchSemanticOccurrenceDecorations(
      'const value = 1\nprint(value)\n',
      [
        { range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 12 }, kind: 'write' },
        { range: { startLine: 2, startColumn: 7, endLine: 2, endColumn: 12 }, kind: 'read' },
        { range: { startLine: 2, startColumn: 7, endLine: 2, endColumn: 12 }, kind: 'read' },
      ]
    )
    assert.equal(exactOccurrences.size, 2)
    const semanticDecorations = buildWorkbenchSemanticTokenDecorations(
      'component App:\n',
      [{
        range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 14 },
        type: 'function',
        modifiers: ['declaration'],
      }]
    )
    assert.equal(semanticDecorations.size, 1)
    for (const keyword of [
      'abstract',
      'assert',
      'case',
      'constructor',
      'enum',
      'extends',
      'extern',
      'get',
      'is',
      'js',
      'json',
      'module',
      'match',
      'null',
      'override',
      'pass',
      'private',
      'readonly',
      'static',
      'super',
      'test',
      'throw',
      'type',
      'unsafe',
      'using',
    ])
      assert.ok(VELAR_EDITOR_KEYWORDS.includes(keyword as typeof VELAR_EDITOR_KEYWORDS[number]))
    for (const webKeyword of [
      'action',
      'cleanup',
      'component',
      'computed',
      'global',
      'mounted',
      'resource',
      'state',
      'style',
      'watch',
    ])
      assert.ok(!VELAR_EDITOR_KEYWORDS.includes(webKeyword as typeof VELAR_EDITOR_KEYWORDS[number]))
    for (const removedKeyword of ['init', 'none'])
      assert.ok(!VELAR_EDITOR_KEYWORDS.includes(removedKeyword as typeof VELAR_EDITOR_KEYWORDS[number]))

    const fallbackTree = (doc: string): string => syntaxTree(EditorState.create({
      doc,
      extensions: [velarScript()],
    })).toString()
    assert.equal(
      fallbackTree('const path = r"C:\\\\Users\\foo"\n'),
      'Document(keyword,"variableName.definition",operator,string)'
    )
    assert.equal(
      fallbackTree('const identity = r"^[a-z][a-z0-9\\_.-]\\*$"\n'),
      'Document(keyword,"variableName.definition",operator,regexp)'
    )
    assert.equal(
      fallbackTree('const mask = (0x0f << 2) | 0b0011\nconst label = `binary`\n'),
      'Document(keyword,"variableName.definition",operator,punctuation,number,operator,number,punctuation,operator,number,keyword,"variableName.definition",operator,string)'
    )
    assert.equal(
      fallbackTree('const text = "\n    ordinary "quotes" stay content\n"\nconst ready = true\n'),
      'Document(keyword,"variableName.definition",operator,string,string,string,keyword,"variableName.definition",operator,keyword)'
    )
    assert.equal(
      fallbackTree('const broken = "unterminated\nconst recovered = true\n'),
      'Document(keyword,"variableName.definition",operator,string,keyword,"variableName.definition",operator,keyword)'
    )
    assert.equal(
      fallbackTree('const label = f"hello {user.name}"\n'),
      'Document(keyword,"variableName.definition",operator,string,punctuation,variableName,operator,propertyName,punctuation,string)'
    )
    assert.equal(
      fallbackTree('const label = `hello ${user.name}`\n'),
      'Document(keyword,"variableName.definition",operator,string,punctuation,variableName,operator,propertyName,punctuation,string)'
    )
    assert.equal(
      fallbackTree('def treeBlocks(sample: TerrainSample):\n  return range(sample.humidity)\n'),
      'Document(keyword,"variableName.definition.function",punctuation,variableName,punctuation,className,punctuation,keyword,"variableName.function",punctuation,variableName,operator,propertyName,punctuation)'
    )
    assert.equal(
      fallbackTree('const delta = {position: local, revision: nextRevision, changed}\n'),
      'Document(keyword,"variableName.definition",operator,punctuation,propertyName,punctuation,variableName,punctuation,propertyName,punctuation,variableName,punctuation,propertyName,punctuation)'
    )
    for (const header of ['extern js', 'extern js()']) {
      const embeddedJavaScriptTree = fallbackTree([
        `${header}\``,
        '  const referencePattern = /^[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*)+$/',
        '  export function resolve(value) {',
        '    return Object.entries(value).map(([key]) => `${key}`)',
        '  }',
        '`:',
        '  export def resolved(value: string) -> string',
        '',
      ].join('\n'))
      assert.match(embeddedJavaScriptTree, /"string\.special"/u)
      assert.match(embeddedJavaScriptTree, /propertyName/u)
      assert.match(embeddedJavaScriptTree, /"variableName\.definition\.function"/u)
    }
    const typeScriptLanguage = resolveWorkbenchCodeMirrorLanguage('src/main.ts', '')
    const typeScriptTemplateTree = syntaxTree(EditorState.create({
      doc: 'const label = `hello ${user.name}`',
      extensions: [typeScriptLanguage.extension],
    })).toString()
    assert.match(
      typeScriptTemplateTree,
      /TemplateString\(Interpolation\(InterpolationStart,MemberExpression\(VariableName,"\.",PropertyName\),InterpolationEnd\)\)/u
    )

    const decorations = buildWorkbenchBasicKeywordDecorations(
      EditorState.create({ doc: '# unsafe\n// extern\nmodule value\n' }).doc,
      [{ from: 0, to: 32 }],
      'velar'
    )
    const ranges: Array<{ from: number; to: number }> = []
    decorations.between(0, 32, (from, to) => {
      ranges.push({ from, to })
    })
    assert.deepEqual(ranges, [{ from: 2, to: 8 }, { from: 19, to: 25 }])

    const pythonDoc = EditorState.create({ doc: 'value = 1 # if\nif True:\n' }).doc
    const pythonDecorations = buildWorkbenchBasicKeywordDecorations(
      pythonDoc,
      [{ from: 0, to: pythonDoc.length }],
      'python'
    )
    const pythonRanges: Array<{ from: number; to: number }> = []
    pythonDecorations.between(0, pythonDoc.length, (from, to) => {
      pythonRanges.push({ from, to })
    })
    assert.deepEqual(pythonRanges, [{ from: 15, to: 17 }, { from: 18, to: 22 }])
    remove()
  })

  void test('parses common data, configuration, shell, and database files', () => {
    const cases = [
      ['config/app.yml', 'name: workbench\nfeatures:\n  - editor\n', 'yaml', 'YAML'],
      ['assets/icon.svg', '<svg><path d="M0 0" /></svg>\n', 'xml', 'XML'],
      ['db/schema.sql', 'create table projects (id integer primary key);\n', 'sql', 'SQL'],
      ['pyproject.toml', '[project]\nname = "workbench"\n', 'toml', 'TOML'],
      ['scripts/build.sh', '#!/bin/sh\necho "$HOME"\n', 'shell', 'Shell'],
      ['Dockerfile', 'FROM node:24\nRUN bun install\n', 'dockerfile', 'Dockerfile'],
      ['settings.ini', '[editor]\ntheme=light\n', 'properties', 'Properties'],
      ['.env.local', 'WORKBENCH_PORT=3000\n', 'properties', 'Environment'],
      ['.gitignore', '# generated\nnode_modules/\n*.log\n', 'gitignore', 'Git Ignore'],
      ['README.md', '# Workbench\n\n```ts\nconst ready = true\n```\n', 'markdown', 'Markdown'],
    ] as const

    for (const [path, content, languageId, label] of cases) {
      const language = resolveWorkbenchCodeMirrorLanguage(path, fileLanguage(path))
      assert.equal(language.mode, 'builtin', path)
      assert.equal(language.languageId, languageId, path)
      assert.equal(fileLanguage(path), label, path)
      assert.notEqual(
        syntaxTree(EditorState.create({ doc: content, extensions: [language.extension] })).toString(),
        'Document',
        `${path} should produce a parsed syntax tree`
      )
    }
  })

  void test('adds semantic roles and useful hover behavior to TypeScript and JavaScript', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-script-semantics-'))
    const services = new WorkbenchLanguageServices(languagePathResolver)
    const typeScript = [
      'interface User { readonly name: string; format(prefix: string): string }',
      'class Greeter implements User {',
      '  readonly name = "Velar"',
      '  format(prefix: string) { return `${prefix}: ${this.name}` }',
      '}',
      'const greeter = new Greeter()',
      'const label = greeter.format("Hi")',
      '',
    ].join('\n')
    const javaScript = [
      'class Box {',
      '  value = 1',
      '  read(prefix) { return `${prefix}: ${this.value}` }',
      '}',
      'const box = new Box()',
      'box.read("value")',
      '',
    ].join('\n')

    try {
      await writeFile(join(projectRoot, 'main.ts'), typeScript, 'utf8')
      await writeFile(join(projectRoot, 'main.js'), javaScript, 'utf8')
      const resolved = await services.resolveLanguageService({ projectRoot, path: 'main.ts', content: typeScript })
      assert.ok(resolved.capabilities.includes('semantic-tokens'))

      const typeScriptTokens = await services.getSemanticTokens({
        projectRoot,
        path: 'main.ts',
        content: typeScript,
      })
      const typeScriptTokenKinds = typeScriptTokens.tokens.map((token) => ({
        text: languageRangeText(typeScript, token.range),
        type: token.type,
        modifiers: token.modifiers,
      }))
      assert.ok(typeScriptTokenKinds.some((token) => token.text === 'User' && token.type === 'interface'))
      assert.ok(typeScriptTokenKinds.some((token) => token.text === 'Greeter' && token.type === 'class'))
      assert.ok(typeScriptTokenKinds.some((token) => token.text === 'format' && token.type === 'method'))
      assert.ok(typeScriptTokenKinds.some((token) => token.text === 'name' && token.type === 'property'))
      assert.ok(typeScriptTokenKinds.some((token) => token.text === 'prefix' && token.type === 'parameter'))
      assert.ok(typeScriptTokenKinds.some((token) =>
        token.text === 'greeter' && token.type === 'variable' && token.modifiers.includes('readonly')
      ))

      const keywordHover = await services.getHover({
        projectRoot,
        path: 'main.ts',
        content: typeScript,
        position: { line: 1, column: 2 },
      })
      assert.equal(keywordHover.hover, null)
      const methodColumn = typeScript.split('\n')[6]!.indexOf('format') + 2
      const methodHover = await services.getHover({
        projectRoot,
        path: 'main.ts',
        content: typeScript,
        position: { line: 7, column: methodColumn },
      })
      assert.match(methodHover.hover?.displayText ?? '', /format/u)

      const javaScriptTokens = await services.getSemanticTokens({
        projectRoot,
        path: 'main.js',
        content: javaScript,
      })
      const javaScriptTokenKinds = javaScriptTokens.tokens.map((token) => ({
        text: languageRangeText(javaScript, token.range),
        type: token.type,
      }))
      assert.ok(javaScriptTokenKinds.some((token) => token.text === 'Box' && token.type === 'class'))
      assert.ok(javaScriptTokenKinds.some((token) => token.text === 'read' && token.type === 'method'))
      assert.ok(javaScriptTokenKinds.some((token) => token.text === 'value' && token.type === 'property'))
    } finally {
      await services.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('resolves TypeScript standard libraries from packaged Workbench resources', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'workbench-typescript-libs-'))
    const bundledLibDirectory = join(resourcesPath, 'typescript', 'lib')
    await mkdir(bundledLibDirectory, { recursive: true })
    await writeFile(join(bundledLibDirectory, 'lib.esnext.full.d.ts'), '', 'utf8')

    try {
      assert.equal(
        resolveTypeScriptDefaultLibFilePath(
          { target: (await import('typescript')).ScriptTarget.ESNext },
          resourcesPath
        ),
        join(bundledLibDirectory, 'lib.esnext.full.d.ts')
      )
    } finally {
      await rm(resourcesPath, { recursive: true, force: true })
    }
  })

  void test('separates LSP signatures from documentation instead of rendering markdown noise', () => {
    assert.deepEqual(
      buildExternalHoverResult({
        kind: 'markdown',
        value: '``method render(template: string): string``\n\nRenders the selected `template`.',
      }),
      {
        displayText: 'method render(template: string): string',
        documentation: 'Renders the selected template.',
        documentationBlocks: [{
          kind: 'paragraph',
          text: 'Renders the selected `template`.',
        }],
      }
    )
  })

  void test('keeps Velar hover prose plain and isolates fenced examples as code', () => {
    assert.deepEqual(
      buildExternalHoverResult({
        kind: 'markdown',
        value: [
          '``@get``',
          '',
          'Declares a GET route in the current `server`.',
          '',
          '```velar',
          '@get(p"/articles/{id:number}") => {id}',
          '```',
          '',
          'Path captures come from the URL.',
        ].join('\n'),
      }),
      {
        displayText: '@get',
        documentation:
          'Declares a GET route in the current server.\n\n'
          + '@get(p"/articles/{id:number}") => {id}\n\n'
          + 'Path captures come from the URL.',
        documentationBlocks: [
          { kind: 'paragraph', text: 'Declares a GET route in the current `server`.' },
          {
            kind: 'code',
            language: 'velar',
            text: '@get(p"/articles/{id:number}") => {id}',
          },
          { kind: 'paragraph', text: 'Path captures come from the URL.' },
        ],
      }
    )
  })

  void test('does not leak a markdown replacement placeholder for signature-only hover', () => {
    assert.deepEqual(
      buildExternalHoverResult({
        kind: 'markdown',
        value: '``function catalogHeaders: () -> Map<string, string>``',
      }),
      {
        displayText: 'function catalogHeaders: () -> Map<string, string>',
      }
    )
  })

  void test('expands a nearby type alias target into the definition preview', () => {
    assert.equal(
      buildExternalDefinitionPreview([
        'export type BlockMutation extends WorldScoped:',
        '    position: BlockPosition',
        '    blockId: number',
        '',
        'export type SetBlockRequest = BlockMutation',
      ].join('\n'), 5),
      [
        'export type SetBlockRequest = BlockMutation',
        '',
        'export type BlockMutation extends WorldScoped:',
        '    position: BlockPosition',
        '    blockId: number',
      ].join('\n')
    )
  })

  void test('recognizes type hovers for modifier-click information', () => {
    assert.equal(isWorkbenchTypeHover({ displayText: 'type SetBlockRequest: BlockMutation' }), true)
    assert.equal(isWorkbenchTypeHover({ displayText: 'interface Request' }), true)
    assert.equal(isWorkbenchTypeHover({ displayText: 'function parse(request: Request)' }), false)
  })

  void test('anchors decorator hover to the complete role name', () => {
    const state = EditorState.create({ doc: '    @get(p"/api/health"):' })
    for (const position of [4, 5, 6, 7, 8]) {
      assert.deepEqual(getWorkbenchHoverTokenRange(state, position), { from: 4, to: 8 })
    }
  })

  void test('keeps Velar updates independent from the Workbench release', () => {
    const remove = installVelarWorkbenchContribution()
    const velar = resolveBuiltinWorkbenchLanguageService('vel')
    assert.equal(velar?.protocol, undefined)
    assert.equal(velar?.command, 'velar')
    assert.deepEqual(velar?.args, ['lsp'])
    remove()
  })

  void test('injects Velar project detection and generic project commands', () => {
    assert.deepEqual(resolveInjectedWorkbenchProjectLanguages(['package.json']), [])
    const remove = installVelarWorkbenchContribution()
    const [velar] = resolveInjectedWorkbenchProjectLanguages(['src', 'velar.json'])
    assert.equal(velar?.id, 'velarscript')
    assert.deepEqual(velar?.project?.commands.map((command) => command.id), [
      'install',
      'update',
      'check',
      'run',
      'format',
      'format-check',
      'dev',
      'test',
      'test-browser',
      'build',
      'verify',
      'preview',
      'verify-deployment',
    ])
    remove()
  })
})

void describe('shared external LSP client', () => {
  void test('resolves the nearest ancestor Node toolchain for nested projects', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workbench-ancestor-lsp-'))
    const projectRoot = join(workspaceRoot, 'packages', 'server')
    const binRoot = join(workspaceRoot, 'node_modules', '.bin')
    const commandName = 'ancestor-fixture-lsp'
    const command = join(binRoot, process.platform === 'win32' ? `${commandName}.cmd` : commandName)
    await mkdir(projectRoot, { recursive: true })
    await mkdir(binRoot, { recursive: true })
    await writeFile(command, process.platform === 'win32'
      ? `@"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await chmod(command, 0o755)

    const client = new ExternalLspClient(projectRoot, {
      id: 'ancestor-fixture-language',
      label: 'Ancestor Fixture Language',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['ancestor'],
      languages: ['ancestor-fixture-language'],
      command: commandName,
      documentLanguageId: 'ancestor-fixture-language',
    })
    try {
      const diagnostics = await client.getDiagnostics(
        join(projectRoot, 'main.ancestor'),
        'component App:\n'
      )
      assert.deepEqual(diagnostics.map((item) => item.code), ['VEL5001'])
    } finally {
      await client.dispose()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  void test('runs a project package bin with the Workbench runtime instead of its shebang', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workbench-owned-node-lsp-'))
    const projectRoot = join(workspaceRoot, 'packages', 'server')
    const packageRoot = join(workspaceRoot, 'node_modules', '@fixture', 'language-server')
    const binRoot = join(workspaceRoot, 'node_modules', '.bin')
    const command = join(binRoot, process.platform === 'win32' ? 'fixture-lsp.cmd' : 'fixture-lsp')
    await mkdir(projectRoot, { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await mkdir(binRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/language-server',
      bin: { 'fixture-lsp': './server.cjs' },
    }), 'utf8')
    await writeFile(join(packageRoot, 'server.cjs'), await readFile(fixture), 'utf8')
    await writeFile(command, process.platform === 'win32'
      ? '@echo off\r\nexit /b 77\r\n'
      : '#!/usr/bin/env __workbench_missing_node__\n', 'utf8')
    if (process.platform !== 'win32') await chmod(command, 0o755)

    const client = new ExternalLspClient(projectRoot, {
      id: 'workbench-owned-node-fixture',
      label: 'Workbench-owned Node Fixture',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['owned-node'],
      languages: ['owned-node'],
      packageName: '@fixture/language-server',
      command: 'fixture-lsp',
      projectNodePackageBin: 'fixture-lsp',
      documentLanguageId: 'owned-node',
    })
    try {
      const diagnostics = await client.getDiagnostics(
        join(projectRoot, 'main.owned-node'),
        'component App:\n'
      )
      assert.deepEqual(diagnostics.map((item) => item.code), ['VEL5001'])
    } finally {
      await client.dispose()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  void test('restarts an external language server after project dependencies change', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-refresh-lsp-'))
    const manager = new ExternalLspManager()
    const descriptor = {
      id: 'refresh-fixture-language',
      label: 'Refresh Fixture Language',
      installKind: 'builtin' as const,
      runtime: 'lsp-server' as const,
      extensions: ['refresh'],
      languages: ['refresh'],
      command: process.execPath,
      args: [fixture],
      documentLanguageId: 'refresh',
    }
    try {
      await writeFile(join(projectRoot, 'package.json'), '{"dependencies":{}}\n', 'utf8')
      const first = await manager.client(projectRoot, descriptor)
      assert.equal(
        (await first.completion(join(projectRoot, 'main.refresh'), 'comp', { line: 0, character: 4 }))[0]?.label,
        'component'
      )

      await writeFile(
        join(projectRoot, 'package.json'),
        '{"dependencies":{"@velarscript-labs/noise":"0.1.1"}}\n',
        'utf8'
      )
      const refreshed = await manager.client(projectRoot, descriptor)
      assert.notEqual(refreshed, first)
      assert.equal(
        (await refreshed.completion(join(projectRoot, 'main.refresh'), 'comp', { line: 0, character: 4 }))[0]?.label,
        'component'
      )
    } finally {
      await manager.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

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
    const documentHighlights = await client.documentHighlights(path, 'component App:\n', { line: 0, character: 11 })
    const rename = await client.rename(path, 'component App:\n', { line: 0, character: 11 }, 'Shell')
    const symbols = await client.documentSymbols(path, 'component App:\n')
    const signature = await client.signatureHelp(path, 'mount(', { line: 0, character: 6 })
    const hints = await client.inlayHints(path, 'component App:\n', {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 0 },
    })
    const edits = await client.format(path, 'component App:\n')

    assert.deepEqual(diagnostics.map((item) => item.code), ['VEL5001'])
    assert.equal(completions[0]?.label, 'component')
    assert.deepEqual(hover?.contents, { kind: 'markdown', value: 'Velar hover' })
    assert.equal(definitions[0]?.range.start.character, 10)
    assert.equal(references[0]?.range.start.line, 1)
    assert.equal(documentHighlights[0]?.range.start.character, 10)
    assert.equal(rename.changes?.[definitions[0]?.uri ?? '']?.[0]?.newText, 'Shell')
    assert.equal(symbols[0]?.name, 'App')
    assert.equal(signature?.signatures[0]?.label, 'mount(node, target) -> none')
    assert.equal(hints[0]?.label, ': string')
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
      hover: { suppressWords: ['component'] },
    })
    const services = new WorkbenchLanguageServices(languagePathResolver)
    const request = {
      projectRoot,
      path: 'main.fakevel',
      content: 'component App:\n',
      position: { line: 1, column: 11 },
    }

    const resolved = await services.resolveLanguageService(request)
    const suppressedHover = await services.getHover({ ...request, position: { line: 1, column: 2 } })
    const decoratorHover = await services.getHover({
      ...request,
      content: '@component App:\n',
      position: { line: 1, column: 3 },
    })
    const definition = await services.getDefinition(request)
    const references = await services.getReferences(request)
    const documentHighlights = await services.getDocumentHighlights(request)
    const rename = await services.getRename({ ...request, newName: 'Shell' })
    const signatures = await services.getSignatureHelp(request)
    const symbols = await services.getDocumentSymbols(request)
    const hints = await services.getInlayHints({
      projectRoot,
      path: 'main.fakevel',
      content: 'component App:\n',
      ranges: [{ from: 0, to: 15 }],
      syncOpenFiles: true,
    })
    const semanticTokens = await services.getSemanticTokens({
      projectRoot,
      path: 'main.fakevel',
      content: 'component App:\n',
    })
    const codeActions = await services.getCodeActions({
      projectRoot,
      path: 'main.fakevel',
      content: 'component App:\n',
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
      diagnostics: [{
        path: 'main.fakevel',
        severity: 'error',
        message: 'fake diagnostic',
        source: 'fake-velar',
        code: 'VEL5001',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
      }],
    })

    assert.ok(resolved.capabilities.includes('definition'))
    assert.ok(resolved.capabilities.includes('rename'))
    assert.ok(resolved.capabilities.includes('semantic-tokens'))
    assert.ok(resolved.capabilities.includes('code-actions'))
    assert.equal(suppressedHover.hover, null)
    assert.equal(decoratorHover.hover?.displayText, 'Velar hover')
    assert.equal(decoratorHover.hover?.definition?.path, 'main.fakevel')
    assert.equal(definition.locations[0]?.path, 'main.fakevel')
    assert.equal(references.locations[0]?.line, 2)
    assert.deepEqual(documentHighlights.highlights[0], {
      range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 14 },
      kind: 'read',
    })
    assert.equal(rename.changes[0]?.edits[0]?.newText, 'Shell')
    assert.equal(signatures.signatureHelp?.signatures[0]?.parameters[0]?.label, 'node')
    assert.equal(symbols.symbols[0]?.kind, 'class')
    assert.equal(hints.hints[0]?.text, ': string')
    assert.deepEqual(semanticTokens.tokens, [{
      range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 14 },
      type: 'class',
      modifiers: ['declaration'],
    }])
    assert.equal(codeActions.actions[0]?.title, 'Apply fake quick fix')
    assert.equal(codeActions.actions[0]?.changes[0]?.edits[0]?.newText, 'let')
    assert.deepEqual(hints.hints[0]?.position, { line: 1, column: 14 })

    await services.dispose()
    remove()
  })

  void test('preserves string diagnostic codes and explains missing toolchains', async () => {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
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

    const retryRoot = await mkdtemp(join(tmpdir(), 'workbench-retry-lsp-'))
    const retryCommand = join(retryRoot, 'retry-lsp')
    const retriable = new ExternalLspClient(retryRoot, {
      id: 'retry-language',
      label: 'Retry Language',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['retry'],
      languages: ['retry'],
      command: retryCommand,
      documentLanguageId: 'retry',
      protocol: {
        capabilityPath: ['capabilities', 'experimental', 'velar', 'protocolVersion'],
        version: 1,
      },
    })
    await assert.rejects(
      retriable.completion(join(retryRoot, 'probe.retry'), 'comp', { line: 0, character: 4 }),
      /未找到/u
    )
    await writeFile(
      retryCommand,
      `#!/bin/sh\nexec "${process.execPath.replaceAll('"', '\\"')}" "${fixture.replaceAll('"', '\\"')}"\n`,
      'utf8'
    )
    await chmod(retryCommand, 0o755)
    const recoveredCompletions = await retriable.completion(
      join(retryRoot, 'probe.retry'),
      'comp',
      { line: 0, character: 4 }
    )
    assert.equal(recoveredCompletions[0]?.label, 'component')
    await retriable.dispose()
    await rm(retryRoot, { recursive: true, force: true })

    const oversized = new ExternalLspClient(projectRoot, {
      id: 'bounded-fixture-language',
      label: 'Bounded Fixture Language',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['bounded'],
      languages: ['bounded'],
      command: process.execPath,
      args: [fixture, 'oversized'],
      documentLanguageId: 'bounded',
    })
    await assert.rejects(
      oversized.completion(`${projectRoot}/tests/probe.bounded`, 'const value = 1\n', { line: 0, character: 1 }),
      /16 MiB/u
    )
    await oversized.dispose()

    const hanging = new ExternalLspClient(projectRoot, {
      id: 'hanging-fixture-language',
      label: 'Hanging Fixture Language',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['hanging'],
      languages: ['hanging'],
      command: process.execPath,
      args: [fixture, 'hang'],
      documentLanguageId: 'hanging',
    }, 50)
    await assert.rejects(
      hanging.completion(`${projectRoot}/tests/probe.hanging`, 'const value = 1\n', { line: 0, character: 1 }),
      /请求超时.*textDocument\/completion/u
    )
    await hanging.dispose()
  })

  void test('starts the Workbench-owned Pyright runtime', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-pyright-'))
    const services = new WorkbenchLanguageServices(languagePathResolver)
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
