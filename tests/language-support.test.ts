import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { javascriptLanguage } from '@codemirror/lang-javascript'
import { highlightingFor, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { type Highlighter, highlightTree } from '@lezer/highlight'
import { describe, test } from 'bun:test'
import * as ts from 'typescript'

import {
  ExternalLspClient,
  ExternalLspManager,
  resolveExternalLspRuntimeRoot,
} from '../src/main/workspace/language/ExternalLspClient'
import {
  buildExternalDefinitionPreview,
  buildExternalHoverResult,
  WorkbenchLanguageServices,
} from '../src/main/workspace/language/LanguageServices'
import {
  acquireTypeScriptLanguageService,
  clearTypeScriptProjectCache,
  normalizeTypeScriptFileName,
  resolveTypeScriptDefaultLibFilePath,
} from '../src/main/workspace/language/TypeScriptProjectHost'
import {
  buildVelarEmbeddedJavaScriptHighlightDecorations,
  findVelarEmbeddedJavaScriptRanges,
  VELAR_EDITOR_KEYWORDS,
  velarScript,
  VelarWorkbenchEditorLanguage,
} from '../src/renderer/src/models/editor/velarEditor'
import {
  buildWorkbenchBasicKeywordDecorations,
  getWorkbenchJavaScriptKeywordRangeAtPosition,
  WORKBENCH_JAVASCRIPT_KEYWORDS,
  WORKBENCH_TYPESCRIPT_KEYWORDS,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorBasicSyntax'
import {
  buildWorkbenchInlayHintDecorations,
  mapWorkbenchInlayHintDecorationsThroughChanges,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorInlayHints'
import { resolveWorkbenchCodeMirrorLanguage } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguage'
import {
  getWorkbenchHoverTokenRange,
  isWorkbenchTypeHover,
  shouldUseWorkbenchSingleCodeHoverLayout,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageFeatures'
import {
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchExternalLspLanguageService,
  usesWorkbenchExternalSemanticLanguageService,
  usesWorkbenchInlayHintLanguageService,
  usesWorkbenchSemanticLanguageService,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import { mapWorkbenchLanguageServiceCompletionToCodeMirror } from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageServiceCompletions'
import { buildWorkbenchSemanticTokenDecorations } from '../src/renderer/src/models/editor/workbenchCodeMirrorSemanticTokens'
import { workbenchCodeMirrorRiderTheme } from '../src/renderer/src/models/editor/workbenchCodeMirrorTheme'
import { buildWorkbenchSemanticOccurrenceDecorations } from '../src/renderer/src/models/editor/workbenchCodeMirrorTokenOccurrenceHighlight'
import {
  registerWorkbenchEditorLanguage,
  resolveInjectedWorkbenchProjectLanguages,
} from '../src/renderer/src/models/editor/workbenchEditorLanguageContributions'
import { fileLanguage } from '../src/renderer/src/models/shared/workbenchUtils'
import { VelarWorkbenchLanguageService } from '../src/shared/contributions/velar/service'
import {
  getBuiltinWorkbenchLanguageServices,
  registerWorkbenchLanguageService,
  resolveBuiltinWorkbenchLanguageService,
} from '../src/shared/workbenchLanguageServices'

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
    if (!(await stat(root)).isDirectory())
      throw new Error('The language project root must be a directory')
    return root
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath))
      throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    const value = relative(projectRoot, absolutePath)
    if (!isInside(projectRoot, absolutePath))
      throw new Error(`Language path escapes the project: ${absolutePath}`)
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
      'src/shared/workbenchLanguageServices.ts',
      'src/renderer/src/models/editor/workbenchCodeMirrorLanguage.ts',
      'src/main/workspace/language/ExternalLspClient.ts',
    ]
    for (const relativePath of genericFiles) {
      const source = await readFile(join(root, relativePath), 'utf8')
      assert.doesNotMatch(
        source,
        /velarscript|workbenchVelar|VelarTokens|experimental\?\.\['velar'\]/u
      )
    }

    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
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

  void test('leaves indented Sass to syntax highlighting instead of the SCSS service', async () => {
    assert.equal(resolveBuiltinWorkbenchLanguageService('sass'), null)
    assert.equal(resolveBuiltinWorkbenchLanguageService('scss')?.id, 'web-css')
    assert.equal(usesWorkbenchBuiltinLanguageService('styles/app.sass'), false)
    assert.equal(usesWorkbenchBuiltinLanguageService('styles/app.scss'), true)
    assert.equal(resolveWorkbenchCodeMirrorLanguage('styles/app.sass', '').mode, 'builtin')

    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-sass-'))
    const services = new WorkbenchLanguageServices(languagePathResolver)
    try {
      const sass = await services.getDiagnostics({
        projectRoot,
        path: 'app.sass',
        content: '.a\n  color: red\n  &:hover\n    color: blue\n',
      })
      assert.deepEqual(sass.diagnostics, [])
      const scss = await services.getDiagnostics({
        projectRoot,
        path: 'app.scss',
        content: '.a {\n  color: red\n',
      })
      assert.ok(scss.diagnostics.length > 0)
    } finally {
      await services.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
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
    const semanticDecorations = buildWorkbenchSemanticTokenDecorations('component App:\n', [
      {
        range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 14 },
        type: 'function',
        modifiers: ['declaration', 'frameworkDefinition'],
      },
    ])
    assert.equal(semanticDecorations.size, 1)
    semanticDecorations.between(0, 'component App:\n'.length, (_from, _to, value) => {
      assert.match(String(value.spec.class), /cm-workbenchSemantic-frameworkDefinition/u)
    })
    for (const keyword of [
      'abstract',
      'assert',
      'case',
      'constructor',
      'enum',
      'extends',
      'extern',
      'detach',
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
      assert.ok(VELAR_EDITOR_KEYWORDS.includes(keyword as (typeof VELAR_EDITOR_KEYWORDS)[number]))
    assert.ok(VelarWorkbenchLanguageService.hover.suppressWords.includes('detach'))
    for (const webKeyword of [
      'action',
      'cleanup',
      'component',
      'computed',
      'global',
      'mounted',
      'resource',
      'server',
      'state',
      'style',
      'watch',
    ])
      assert.ok(
        !VELAR_EDITOR_KEYWORDS.includes(webKeyword as (typeof VELAR_EDITOR_KEYWORDS)[number])
      )
    for (const removedKeyword of ['init', 'none'])
      assert.ok(
        !VELAR_EDITOR_KEYWORDS.includes(removedKeyword as (typeof VELAR_EDITOR_KEYWORDS)[number])
      )

    const fallbackTree = (doc: string): string =>
      syntaxTree(
        EditorState.create({
          doc,
          extensions: [velarScript()],
        })
      ).toString()
    const fallbackTokens = (doc: string): Array<{ name: string; text: string }> => {
      const state = EditorState.create({ doc, extensions: [velarScript()] })
      const tokens: Array<{ name: string; text: string }> = []
      syntaxTree(state).iterate({
        enter(node) {
          if (node.name !== 'Document')
            tokens.push({ name: node.name, text: state.sliceDoc(node.from, node.to) })
        },
      })
      return tokens
    }
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
      fallbackTree('const route = p"/api/worlds/{worldId:string}/blocks/{blockY:number}"\n'),
      'Document(keyword,"variableName.definition",operator,string,punctuation,variableName,punctuation,atom,punctuation,string,punctuation,variableName,punctuation,atom,punctuation,string)'
    )
    assert.equal(
      fallbackTree('const value: Map<string, Set<List<Promise<Error>>>> = Map()\n'),
      'Document(keyword,"variableName.definition",punctuation,className,operator,atom,punctuation,className,operator,className,operator,className,operator,className,operator,operator,className,punctuation)'
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
      fallbackTree('detach refresh()\n'),
      'Document(keyword,"variableName.function",punctuation)'
    )
    assert.equal(
      fallbackTree('const delta = {position: local, revision: nextRevision, changed}\n'),
      'Document(keyword,"variableName.definition",operator,punctuation,propertyName,punctuation,variableName,punctuation,propertyName,punctuation,variableName,punctuation,propertyName,punctuation)'
    )
    assert.equal(
      fallbackTree(
        [
          'def seed() -> List<Release>:',
          '  return [',
          '    {',
          '      id: "compiler-0-11",',
          '      name: "VelarScript Compiler",',
          '      checks: [{title: "Parser fuzz run clean", done: true}],',
          '    },',
          '  ]',
          '',
        ].join('\n')
      ),
      'Document(keyword,"variableName.definition.function",punctuation,operator,className,operator,className,operator,keyword,punctuation,punctuation,propertyName,punctuation,string,punctuation,propertyName,punctuation,string,punctuation,propertyName,punctuation,punctuation,propertyName,punctuation,string,punctuation,propertyName,punctuation,keyword,punctuation,punctuation,punctuation)'
    )
    assert.equal(
      fallbackTree(
        [
          'const shell: Look = look:',
          '  minHeight = 100vh',
          '  color = ink',
          '  background = paper',
          '  fontFamily = bodyFont',
          '',
          'const ordinary = color',
          '',
        ].join('\n')
      ),
      'Document(keyword,"variableName.definition",punctuation,className,operator,keyword,punctuation,propertyName,operator,number,variableName,propertyName,operator,variableName,propertyName,operator,variableName,propertyName,operator,variableName,keyword,"variableName.definition",operator,variableName)'
    )
    assert.equal(
      fallbackTree(
        [
          'component App(title: string):',
          '  state ready = true',
          '  return <main look={pageLook}><h1>{title}</h1></main>',
          '',
        ].join('\n')
      ),
      'Document(keyword,"variableName.definition.special",punctuation,variableName,punctuation,atom,punctuation,keyword,"variableName.definition.special",operator,keyword,keyword,punctuation,tagName,attributeName,operator,punctuation,variableName,punctuation,tagName,punctuation,variableName,punctuation,tagName,punctuation,tagName,punctuation)'
    )
    assert.equal(
      fallbackTree(
        'return <button type="button" title=\'Settings\' data-copy=`{literal}`>Open</button>\n'
      ),
      'Document(keyword,punctuation,tagName,attributeName,operator,string,attributeName,operator,string,attributeName,operator,string,punctuation,punctuation,tagName,punctuation)'
    )
    assert.equal(
      fallbackTree(
        [
          'component AddCheckForm:',
          '  return <form><p>Add release check</p><label>Title</label></form>',
          '',
        ].join('\n')
      ),
      'Document(keyword,"variableName.definition.special",punctuation,keyword,punctuation,tagName,punctuation,tagName,punctuation,punctuation,tagName,punctuation,tagName,punctuation,punctuation,tagName,punctuation,tagName,punctuation)'
    )
    const nestedJsx = [
      'component ReleaseList(releases: readonly List<Release>):',
      '  return <ul look={listLook} data-release-list>',
      '    {releases.map(release => <li key={release.id} look={rowLook}>',
      '      <Link to={f"/releases/{release.id}"} look={titleLook}>{f"{release.name}"}</Link>',
      '      <StagePill stage={release.stage} />',
      '      <p look={mutedLook} data-release-note>',
      '        {f"Target {release.target}"}',
      '      </p>',
      '      <div look={spanLook}>',
      '        <ReadinessBar percent={readiness(release)} label={f"{release.name} readiness"} />',
      '      </div>',
      '    </li>)}',
      '  </ul>',
      '',
    ].join('\n')
    const nestedJsxTokens = fallbackTokens(nestedJsx)
    assert.deepEqual(
      nestedJsxTokens.filter(({ name }) => name === 'tagName').map(({ text }) => text),
      ['ul', 'li', 'Link', 'Link', 'StagePill', 'p', 'p', 'div', 'ReadinessBar', 'div', 'li', 'ul']
    )
    assert.deepEqual(
      nestedJsxTokens.filter(({ name }) => name === 'attributeName').map(({ text }) => text),
      [
        'look',
        'data-release-list',
        'key',
        'look',
        'to',
        'look',
        'stage',
        'look',
        'data-release-note',
        'look',
        'percent',
        'label',
      ]
    )
    assert.equal(
      fallbackTree('export computed openTasks = tasks.filter(task => not task.done).size\n'),
      'Document(keyword,keyword,"variableName.definition.special",operator,variableName,operator,"propertyName.function",punctuation,variableName,operator,keyword,variableName,operator,propertyName,punctuation,operator,propertyName)'
    )
    assert.equal(
      fallbackTree('const component = render\n'),
      'Document(keyword,"variableName.definition",operator,variableName)'
    )
    assert.equal(
      fallbackTree('component RouteNotFound\n'),
      'Document(keyword,"variableName.definition.special")'
    )
    assert.equal(
      fallbackTree('export server articles:\n'),
      'Document(keyword,keyword,"variableName.definition.special",punctuation)'
    )
    for (const header of ['extern js', 'extern js()']) {
      const embeddedJavaScript = [
        `${header}\``,
        '  const referencePattern = /^[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*)+$/',
        '  export function resolve(value) {',
        '    return Object.entries(value).map(([key]) => `${key}`)',
        '  }',
        '`:',
        '  export def resolved(value: string) -> string',
        '',
      ].join('\n')
      const embeddedJavaScriptTree = fallbackTree(embeddedJavaScript)
      assert.match(embeddedJavaScriptTree, /"string\.special"/u)
      assert.match(embeddedJavaScriptTree, /propertyName/u)
      assert.deepEqual(
        fallbackTokens(embeddedJavaScript)
          .filter(({ text }) => text === 'resolve')
          .map(({ name }) => name),
        ['variableName.definition']
      )
    }

    const javaScriptSource = [
      'const instances = new WeakSet()',
      'function requireCanvas(canvas) {',
      '  if (!Number.isFinite(canvas)) throw new TypeError("invalid")',
      '}',
      'export class Surface {',
      '  constructor() { this.items = new Map() }',
      '}',
      '',
    ].join('\n')
    const velarSource = [
      'const example = "',
      '  extern js`',
      '    new HiddenInsideLayoutString()',
      '  `:',
      '"',
      'extern js`',
      javaScriptSource,
      '`:',
      '  export def requireCanvas(value: unknown) -> unknown',
      '',
    ].join('\n')
    const embeddedRanges = findVelarEmbeddedJavaScriptRanges(velarSource)
    assert.deepEqual(embeddedRanges, [
      {
        from: velarSource.indexOf(javaScriptSource),
        to: velarSource.indexOf('`:', velarSource.indexOf(javaScriptSource)),
      },
    ])

    const javaScriptLanguage = resolveWorkbenchCodeMirrorLanguage('src/example.js', '')
    const javaScriptState = EditorState.create({
      doc: javaScriptSource,
      extensions: [javaScriptLanguage.extension, workbenchCodeMirrorRiderTheme],
    })
    const javaScriptTree = javascriptLanguage.parser.parse(javaScriptSource)
    const javaScriptHighlighter: Highlighter = {
      style: (tags) => highlightingFor(javaScriptState, tags, javaScriptTree.topNode.type),
    }
    const expectedClasses = new Map<string, string>()
    highlightTree(javaScriptTree, javaScriptHighlighter, (from, to, classes) => {
      expectedClasses.set(javaScriptSource.slice(from, to), classes)
    })

    const velarState = EditorState.create({
      doc: velarSource,
      extensions: [velarScript(), workbenchCodeMirrorRiderTheme],
    })
    const embeddedDecorations = buildVelarEmbeddedJavaScriptHighlightDecorations(velarState)
    const embeddedClasses = new Map<string, string>()
    embeddedDecorations.between(0, velarSource.length, (from, to, value) => {
      embeddedClasses.set(velarSource.slice(from, to), String(value.spec.class))
    })
    for (const token of [
      'WeakSet',
      'requireCanvas',
      'Number',
      'isFinite',
      'TypeError',
      'Surface',
      'constructor',
      'Map',
    ])
      assert.equal(embeddedClasses.get(token), expectedClasses.get(token), token)

    const typeScriptLanguage = resolveWorkbenchCodeMirrorLanguage('src/main.ts', '')
    const typeScriptTemplateTree = syntaxTree(
      EditorState.create({
        doc: 'const label = `hello ${user.name}`',
        extensions: [typeScriptLanguage.extension],
      })
    ).toString()
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
    assert.deepEqual(ranges, [
      { from: 2, to: 8 },
      { from: 19, to: 25 },
    ])

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
    assert.deepEqual(pythonRanges, [
      { from: 15, to: 17 },
      { from: 18, to: 22 },
    ])

    const typeScriptDoc = EditorState.create({
      doc: 'await this.load(undefined) // await\n"this undefined"\n',
    }).doc
    const typeScriptDecorations = buildWorkbenchBasicKeywordDecorations(
      typeScriptDoc,
      [{ from: 0, to: typeScriptDoc.length }],
      'typescript'
    )
    const typeScriptRanges: Array<{ from: number; to: number }> = []
    typeScriptDecorations.between(0, typeScriptDoc.length, (from, to) => {
      typeScriptRanges.push({ from, to })
    })
    assert.deepEqual(typeScriptRanges, [
      { from: 0, to: 5 },
      { from: 6, to: 10 },
      { from: 16, to: 25 },
    ])
    assert.deepEqual(getWorkbenchJavaScriptKeywordRangeAtPosition(typeScriptDoc, 2, 'typescript'), {
      from: 0,
      to: 5,
    })
    assert.equal(
      getWorkbenchJavaScriptKeywordRangeAtPosition(typeScriptDoc, 31, 'typescript'),
      null
    )
    assert.equal(
      getWorkbenchJavaScriptKeywordRangeAtPosition(typeScriptDoc, 40, 'typescript'),
      null
    )

    for (const keyword of [
      'accessor',
      'defer',
      'enum',
      'implements',
      'interface',
      'package',
      'private',
      'protected',
      'public',
      'using',
    ]) {
      assert.ok(
        WORKBENCH_JAVASCRIPT_KEYWORDS.includes(
          keyword as (typeof WORKBENCH_JAVASCRIPT_KEYWORDS)[number]
        )
      )
    }
    const allJavaScriptKeywords = WORKBENCH_JAVASCRIPT_KEYWORDS.join(' ')
    const allJavaScriptKeywordsDoc = EditorState.create({ doc: allJavaScriptKeywords }).doc
    assert.equal(
      buildWorkbenchBasicKeywordDecorations(
        allJavaScriptKeywordsDoc,
        [{ from: 0, to: allJavaScriptKeywordsDoc.length }],
        'javascript'
      ).size,
      WORKBENCH_JAVASCRIPT_KEYWORDS.length
    )

    const compilerKeywords: string[] = []
    for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind += 1) {
      const keyword = ts.tokenToString(kind)
      if (keyword) compilerKeywords.push(keyword)
    }
    assert.deepEqual([...WORKBENCH_TYPESCRIPT_KEYWORDS], compilerKeywords)

    const allTypeScriptKeywords = WORKBENCH_TYPESCRIPT_KEYWORDS.join(' ')
    const allTypeScriptKeywordsDoc = EditorState.create({ doc: allTypeScriptKeywords }).doc
    assert.equal(
      buildWorkbenchBasicKeywordDecorations(
        allTypeScriptKeywordsDoc,
        [{ from: 0, to: allTypeScriptKeywordsDoc.length }],
        'typescript'
      ).size,
      WORKBENCH_TYPESCRIPT_KEYWORDS.length
    )
    remove()
  })

  void test('filters contextual LSP values by their source text while preserving the visible label', () => {
    const completion = mapWorkbenchLanguageServiceCompletionToCodeMirror({
      state: EditorState.create({ doc: 'cursor: no', selection: { anchor: 10 } }),
      path: 'src/main.vel',
      item: {
        label: '"no-drop"',
        filterText: 'no-drop',
        insertText: 'no-drop',
        kind: 'property',
      },
    })
    assert.equal(completion.label, 'no-drop')
    assert.equal(completion.displayLabel, '"no-drop"')
    // 写入的是源码里的值，不是列表里带引号的显示文字。
    assert.equal(completion.apply, 'no-drop')
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
        syntaxTree(
          EditorState.create({ doc: content, extensions: [language.extension] })
        ).toString(),
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
      'const builtins = [Date.now(), Math.min(1, 2), Number.NaN]',
      'type PrimitiveKinds = string | number | boolean | bigint | symbol | object | unknown | any | never | void | undefined',
      'enum IpcChannel { Ready }',
      'class List<T> { constructor(readonly value: T) {} }',
      'type ClassLike = Map<string, number> | Set<string> | List<string> | Promise<void> | Error',
      'const globalValues = [undefined, NaN, Infinity, globalThis]',
      'const objectValue = { undefined: "property", NaN: 1 }',
      'objectValue.undefined',
      'function shadowBuiltins(undefined: number, NaN: number, Infinity: number, globalThis: number) {',
      '  return [undefined, NaN, Infinity, globalThis]',
      '}',
      'const channel = IpcChannel.Ready',
      '',
    ].join('\n')
    const javaScript = [
      'class Box {',
      '  value = 1',
      '  read(prefix) { return `${prefix}: ${this.value}` }',
      '}',
      'const box = new Box()',
      'box.read("value")',
      'const values = Array.isArray(box) ? Object.keys(box) : []',
      'const globals = [undefined, NaN, Infinity, globalThis]',
      'const objectValue = { undefined: "property" }',
      'objectValue.undefined',
      'function shadowBuiltins(undefined, NaN, Infinity, globalThis) {',
      '  return [undefined, NaN, Infinity, globalThis]',
      '}',
      '',
    ].join('\n')

    try {
      await writeFile(join(projectRoot, 'main.ts'), typeScript, 'utf8')
      await writeFile(join(projectRoot, 'main.mjs'), javaScript, 'utf8')
      const resolved = await services.resolveLanguageService({
        projectRoot,
        path: 'main.ts',
        content: typeScript,
      })
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
      assert.ok(
        typeScriptTokenKinds.some((token) => token.text === 'User' && token.type === 'interface')
      )
      assert.ok(
        typeScriptTokenKinds.some((token) => token.text === 'Greeter' && token.type === 'class')
      )
      assert.ok(
        typeScriptTokenKinds.some((token) => token.text === 'format' && token.type === 'method')
      )
      assert.ok(
        typeScriptTokenKinds.some((token) => token.text === 'name' && token.type === 'property')
      )
      assert.ok(
        typeScriptTokenKinds.some((token) => token.text === 'prefix' && token.type === 'parameter')
      )
      assert.ok(
        typeScriptTokenKinds.some(
          (token) =>
            token.text === 'greeter' &&
            token.type === 'variable' &&
            token.modifiers.includes('readonly')
        )
      )
      for (const builtin of ['Date', 'Math', 'Number']) {
        assert.ok(
          typeScriptTokenKinds.some(
            (token) => token.text === builtin && token.modifiers.includes('defaultLibrary')
          ),
          `${builtin} should inherit its TypeScript default-library classification`
        )
      }
      const uniqueTokenRanges = new Set(
        typeScriptTokens.tokens.map((token) =>
          [
            token.range.startLine,
            token.range.startColumn,
            token.range.endLine,
            token.range.endColumn,
          ].join(':')
        )
      )
      assert.equal(uniqueTokenRanges.size, typeScriptTokens.tokens.length)

      const keywordTokens = typeScriptTokenKinds.filter((token) => token.type === 'keyword')
      for (const primitive of [
        'any',
        'bigint',
        'boolean',
        'never',
        'number',
        'object',
        'string',
        'symbol',
        'undefined',
        'unknown',
        'void',
      ]) {
        assert.ok(
          keywordTokens.some((token) => token.text === primitive),
          `${primitive} should use the semantic keyword role`
        )
      }
      assert.equal(keywordTokens.filter((token) => token.text === 'undefined').length, 2)
      assert.equal(keywordTokens.filter((token) => token.text === 'NaN').length, 1)
      assert.equal(keywordTokens.filter((token) => token.text === 'Infinity').length, 1)
      assert.equal(
        typeScriptTokenKinds.filter(
          (token) =>
            token.text === 'globalThis' &&
            token.type === 'variable' &&
            token.modifiers.includes('defaultLibrary')
        ).length,
        1
      )
      for (const builtinClass of ['Error', 'Map', 'Promise', 'Set']) {
        assert.ok(
          typeScriptTokenKinds.some(
            (token) =>
              token.text === builtinClass &&
              ['class', 'interface', 'type'].includes(token.type) &&
              token.modifiers.includes('defaultLibrary')
          ),
          `${builtinClass} should retain a default-library class-like role`
        )
      }
      assert.ok(
        typeScriptTokenKinds.some((token) => token.text === 'Ready' && token.type === 'enumMember')
      )

      const decorationClasses = new Map<string, string[]>()
      buildWorkbenchSemanticTokenDecorations(typeScript, typeScriptTokens.tokens).between(
        0,
        typeScript.length,
        (from, to, value) => {
          const text = typeScript.slice(from, to)
          const values = decorationClasses.get(text) ?? []
          values.push(String(value.spec.class))
          decorationClasses.set(text, values)
        }
      )
      for (const primitive of ['string', 'number', 'boolean', 'undefined']) {
        assert.ok(
          decorationClasses
            .get(primitive)
            ?.some((className) => className.includes('cm-workbenchSemantic-keyword')),
          `${primitive} should render with the keyword class`
        )
      }
      for (const builtinClass of ['Error', 'List', 'Map', 'Promise', 'Set']) {
        assert.ok(
          decorationClasses
            .get(builtinClass)
            ?.some((className) => className.includes('cm-workbenchSemantic-builtinType')),
          `${builtinClass} should render with the built-in class color`
        )
      }
      assert.ok(
        decorationClasses
          .get('Ready')
          ?.every((className) => className.includes('cm-workbenchSemantic-enumMember'))
      )
      assert.ok(
        decorationClasses
          .get('undefined')
          ?.some((className) => className.includes('cm-workbenchSemantic-property'))
      )

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

      const builtinHoverCases = [
        { path: 'main.ts', content: typeScript, line: 8, symbol: 'now' },
        { path: 'main.mjs', content: javaScript, line: 7, symbol: 'isArray' },
        { path: 'main.mjs', content: javaScript, line: 7, symbol: 'keys' },
      ] as const
      for (const hoverCase of builtinHoverCases) {
        const sourceLine = hoverCase.content.split('\n')[hoverCase.line - 1] ?? ''
        const hover = await services.getHover({
          projectRoot,
          path: hoverCase.path,
          content: hoverCase.content,
          position: {
            line: hoverCase.line,
            column: sourceLine.indexOf(hoverCase.symbol) + 2,
          },
        })
        assert.match(hover.hover?.displayText ?? '', new RegExp(hoverCase.symbol, 'u'))
        assert.ok(
          (hover.hover?.documentation?.trim().length ?? 0) > 12,
          `${hoverCase.symbol} should include the standard-library usage documentation`
        )
      }

      const javaScriptTokens = await services.getSemanticTokens({
        projectRoot,
        path: 'main.mjs',
        content: javaScript,
      })
      const javaScriptTokenKinds = javaScriptTokens.tokens.map((token) => ({
        text: languageRangeText(javaScript, token.range),
        type: token.type,
        modifiers: token.modifiers,
      }))
      assert.ok(
        javaScriptTokenKinds.some((token) => token.text === 'Box' && token.type === 'class')
      )
      assert.ok(
        javaScriptTokenKinds.some((token) => token.text === 'read' && token.type === 'method')
      )
      assert.ok(
        javaScriptTokenKinds.some((token) => token.text === 'value' && token.type === 'property')
      )
      for (const globalKeyword of ['Infinity', 'NaN', 'undefined']) {
        assert.equal(
          javaScriptTokenKinds.filter(
            (token) => token.text === globalKeyword && token.type === 'keyword'
          ).length,
          1
        )
      }
      assert.equal(
        javaScriptTokenKinds.filter(
          (token) =>
            token.text === 'globalThis' &&
            token.type === 'variable' &&
            token.modifiers.includes('defaultLibrary')
        ).length,
        1
      )
      assert.ok(
        javaScriptTokenKinds.some(
          (token) => token.text === 'undefined' && token.type === 'property'
        )
      )
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

  void test('selects the narrow owning TypeScript config outside the source ancestry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-partitioned-tsconfig-'))
    const requestPath = join(projectRoot, 'src', 'mods', 'project', 'ProjectCodeQuery.ts')
    const unrelatedPath = join(projectRoot, 'src', 'other.ts')
    const partitionConfigPath = join(
      projectRoot,
      'tsconfig',
      'typecheck',
      'node-mods-capabilities.json'
    )
    const packageRoot = join(projectRoot, 'node_modules', '@fixture', 'development')
    const source =
      "import type { Runtime } from '@fixture/development/runtime'\nconst value: Runtime = { ready: true }\n"

    try {
      await mkdir(join(projectRoot, 'src', 'mods', 'project'), { recursive: true })
      await mkdir(join(projectRoot, 'tsconfig', 'typecheck'), { recursive: true })
      await mkdir(join(packageRoot, 'dist', 'runtime'), { recursive: true })
      await writeFile(requestPath, source, 'utf8')
      await writeFile(unrelatedPath, 'export const unrelated = true\n', 'utf8')
      await writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({
          type: 'module',
          dependencies: { '@fixture/development': '1.0.0' },
        }),
        'utf8'
      )
      await writeFile(
        join(projectRoot, 'tsconfig.json'),
        JSON.stringify({ files: [], references: [{ path: './tsconfig.node.json' }] }),
        'utf8'
      )
      await writeFile(
        join(projectRoot, 'tsconfig.node.json'),
        JSON.stringify({
          compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ESNext' },
          files: [],
        }),
        'utf8'
      )
      await writeFile(
        join(projectRoot, 'tsconfig.eslint.json'),
        JSON.stringify({ extends: './tsconfig.json', include: ['src/**/*.ts'] }),
        'utf8'
      )
      await writeFile(
        partitionConfigPath,
        JSON.stringify({
          extends: '../../tsconfig.node.json',
          compilerOptions: { noEmit: true },
          include: ['../../src/mods/project/**/*.ts'],
        }),
        'utf8'
      )
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@fixture/development',
          version: '1.0.0',
          type: 'module',
          exports: {
            './runtime': {
              types: './dist/runtime/index.d.ts',
              import: './dist/runtime/index.js',
            },
          },
        }),
        'utf8'
      )
      await writeFile(
        join(packageRoot, 'dist', 'runtime', 'index.d.ts'),
        'export interface Runtime { ready: boolean }\n',
        'utf8'
      )

      const project = acquireTypeScriptLanguageService(
        projectRoot,
        requestPath,
        [],
        new Map([[requestPath, source]])
      )

      assert.equal(project.config.configPath, normalizeTypeScriptFileName(partitionConfigPath))
      assert.equal(project.compilerOptions.moduleResolution, ts.ModuleResolutionKind.Bundler)
      assert.deepEqual(project.service.getSemanticDiagnostics(requestPath), [])
    } finally {
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('uses modern package exports resolution when a derived config omits module resolution', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-solution-style-tsconfig-'))
    const requestPath = join(projectRoot, 'src', 'rendererCatalog.tsx')
    const packageRoot = join(projectRoot, 'node_modules', '@fixture', 'agent')
    const source =
      "import type { Protocol } from '@fixture/agent/protocol'\nexport const protocol: Protocol = { ready: true }\n"

    try {
      await mkdir(join(projectRoot, 'src'), { recursive: true })
      await mkdir(join(packageRoot, 'dist', 'protocol'), { recursive: true })
      await writeFile(requestPath, source, 'utf8')
      await writeFile(
        join(projectRoot, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { paths: {} },
          files: [],
          references: [{ path: './tsconfig.web.json' }],
        }),
        'utf8'
      )
      await writeFile(
        join(projectRoot, 'tsconfig.web.json'),
        JSON.stringify({
          compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ESNext' },
          files: [],
        }),
        'utf8'
      )
      await writeFile(
        join(projectRoot, 'tsconfig.eslint.json'),
        JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: { noEmit: true },
          include: ['src/**/*.tsx'],
        }),
        'utf8'
      )
      await writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { '@fixture/agent': '1.0.0' } }),
        'utf8'
      )
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@fixture/agent',
          version: '1.0.0',
          type: 'module',
          exports: {
            './protocol': {
              types: './dist/protocol/index.d.ts',
              import: './dist/protocol/index.js',
            },
          },
        }),
        'utf8'
      )
      await writeFile(
        join(packageRoot, 'dist', 'protocol', 'index.d.ts'),
        'export interface Protocol { ready: boolean }\n',
        'utf8'
      )

      const project = acquireTypeScriptLanguageService(
        projectRoot,
        requestPath,
        [],
        new Map([[requestPath, source]])
      )

      assert.equal(
        project.config.configPath,
        normalizeTypeScriptFileName(join(projectRoot, 'tsconfig.eslint.json'))
      )
      assert.equal(project.compilerOptions.moduleResolution, ts.ModuleResolutionKind.Bundler)
      assert.deepEqual(project.service.getSemanticDiagnostics(requestPath), [])
    } finally {
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
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
        documentationBlocks: [
          {
            kind: 'paragraph',
            text: 'Renders the selected `template`.',
          },
        ],
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
          'Declares a GET route in the current server.\n\n' +
          '@get(p"/articles/{id:number}") => {id}\n\n' +
          'Path captures come from the URL.',
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
        documentation: undefined,
        documentationBlocks: undefined,
      }
    )
  })

  void test('renders Pyright hover markdown as a signature and plain documentation', () => {
    assert.deepEqual(
      buildExternalHoverResult({
        kind: 'markdown',
        value: [
          '```python',
          '(function) def greet(',
          '    name: str,',
          '    times: int = 1',
          ') -> str',
          '```',
          '---',
          'Greet **someone**. See [docs](https://example.com).',
          '',
          'Args:  ',
          '&nbsp;&nbsp;&nbsp;&nbsp;name: the \\*name\\* to greet  ',
          '&nbsp;&nbsp;&nbsp;&nbsp;times: how many `times` &lt;= 3',
        ].join('\n'),
      }),
      {
        displayText: '(function) def greet(\n    name: str,\n    times: int = 1\n) -> str',
        documentation:
          'Greet someone. See docs.\n\n' +
          'Args:\n    name: the *name* to greet\n' +
          '    times: how many times <= 3',
        documentationBlocks: [
          { kind: 'paragraph', text: 'Greet someone. See docs.' },
          {
            kind: 'paragraph',
            text: 'Args:\n    name: the *name* to greet\n    times: how many `times` <= 3',
          },
        ],
      }
    )
    assert.deepEqual(buildExternalHoverResult({ kind: 'plaintext', value: 'a *b*\nc' }), {
      displayText: 'a *b*\nc',
    })
    assert.deepEqual(
      buildExternalHoverResult({ kind: 'markdown', value: '# Title\n\n- `one`\n- two' }),
      {
        displayText: 'Title\n\n• one\n• two',
      }
    )
  })

  void test('expands a nearby type alias target into the definition preview', () => {
    assert.equal(
      buildExternalDefinitionPreview(
        [
          'export type BlockMutation extends WorldScoped:',
          '    position: BlockPosition',
          '    blockId: number',
          '',
          'export type SetBlockRequest = BlockMutation',
        ].join('\n'),
        5
      ),
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

  void test('keeps the hover interactive until a modifier-click navigation actually opens', async () => {
    const editor = await readFile('src/renderer/src/components/editor/CodeMirrorEditor.tsx', 'utf8')

    assert.match(
      editor,
      /reconfigureCompartment\(\s*viewRef\.current,\s*languageHoverCompartment,\s*languageServiceHoverExtension\s*\)/u
    )
    assert.doesNotMatch(editor, /languageHoverCompartment\.reconfigure\(\s*active\s*\?\s*\[\]/u)
    assert.match(
      editor,
      /if \(location\)[\s\S]{0,240}closeHoverTooltips[\s\S]{0,360}onOpenSymbolLocations/u
    )
    assert.match(editor, /const definitionResult = await getWorkbenchLanguageServiceDefinition/u)
    assert.doesNotMatch(
      editor,
      /Promise\.all\([\s\S]{0,320}getWorkbenchLanguageServiceDefinition[\s\S]{0,320}getWorkbenchLanguageServiceReferences/u
    )
    const definitionQuery = editor.indexOf(
      'const definitionResult = await getWorkbenchLanguageServiceDefinition'
    )
    const initialLocations = editor.indexOf('references: [],', definitionQuery)
    const referenceQuery =
      initialLocations +
      editor
        .slice(initialLocations)
        .search(
          /void getWorkbenchLanguageServiceReferences\(\s*request,\s*hostRuntime\s*\)\s*\.then/u
        )
    const staleReferenceGuard = editor.indexOf(
      'requestGeneration !== definitionRequestGenerationRef.current',
      referenceQuery
    )
    const resolvedLocations = editor.indexOf(
      'references: referencesResult.data.locations',
      staleReferenceGuard
    )
    assert.ok(definitionQuery >= 0)
    assert.ok(initialLocations > definitionQuery)
    assert.ok(referenceQuery > initialLocations)
    assert.ok(staleReferenceGuard > referenceQuery)
    assert.ok(resolvedLocations > staleReferenceGuard)

    const hoverFeatures = await readFile(
      'src/renderer/src/models/editor/workbenchCodeMirrorLanguageFeatures.ts',
      'utf8'
    )
    assert.match(
      hoverFeatures,
      /getWorkbenchJavaScriptKeywordRangeAtPosition\([\s\S]{0,180}if \(keywordRange && !diagnosticRange\) return null/u
    )
    assert.match(
      hoverFeatures,
      /hoverTooltip\(\s*async[\s\S]{0,2600}await getWorkbenchLanguageServiceHover[\s\S]{0,420}if \(!diagnosticRange && !resolvedHover\) return null/u
    )
    // 诊断的修复另外问、回来再补按钮：不排在悬浮说明的请求前面等。
    assert.doesNotMatch(hoverFeatures, /await context\.codeActions/u)
    assert.doesNotMatch(hoverFeatures, /buildWorkbenchEditorHoverStatusDom/u)
    assert.match(hoverFeatures, /scheduleResolvedHoverRender[\s\S]{0,220}requestAnimationFrame/u)
    assert.match(
      hoverFeatures,
      /definitionPreviewExpanded = true\s+scheduleResolvedHoverRender\(\)/u
    )
  })

  void test('keeps long hover and signature content inside the tooltip boundary', async () => {
    const styles = await readFile('src/renderer/src/styles/11-editor-tooltips.module.css', 'utf8')

    assert.match(
      styles,
      /\.editorSymbolTooltip\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?max-width:\s*min\(460px, calc\(100vw - 32px\)\);[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?overflow-x:\s*hidden;/u
    )
    assert.match(
      styles,
      /\.editorSymbolTooltipTitle\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;/u
    )
    assert.match(
      styles,
      /\.editorSignatureTooltip\s*\{[\s\S]*?max-width:\s*min\(520px, calc\(100vw - 32px\)\);[\s\S]*?overflow-wrap:\s*anywhere;/u
    )
  })

  void test('renders a lone hover code block as the scrollable tooltip surface', async () => {
    const signatureOnly = {
      displayText: 'const values: readonly ["system", "project", "browser"]',
    }
    assert.equal(shouldUseWorkbenchSingleCodeHoverLayout(signatureOnly), true)
    assert.equal(
      shouldUseWorkbenchSingleCodeHoverLayout({
        ...signatureOnly,
        documentation: 'Capability scopes.',
      }),
      false
    )
    assert.equal(
      shouldUseWorkbenchSingleCodeHoverLayout({
        displayText: '',
        documentationBlocks: [{ kind: 'code', text: 'type Value = string' }],
      }),
      true
    )
    assert.equal(
      shouldUseWorkbenchSingleCodeHoverLayout(signatureOnly, {
        hasDiagnostics: true,
      }),
      false
    )

    const styles = await readFile('src/renderer/src/styles/11-editor-tooltips.module.css', 'utf8')
    assert.match(
      styles,
      /\.editorSymbolTooltip\[data-layout='single-code'\]\s*\{[\s\S]*?padding:\s*0;[\s\S]*?overflow:\s*hidden;/u
    )
    assert.match(
      styles,
      /data-layout='single-code'[\s\S]{0,180}\.editorSymbolTooltipCode\s*\{[\s\S]*?max-height:\s*min\(420px, 50vh\);[\s\S]*?overflow-y:\s*auto;/u
    )
  })

  void test('keeps inferred type hints stable while a fresh document analysis is pending', () => {
    const state = EditorState.create({ doc: 'const value = createValue()' })
    const decorations = buildWorkbenchInlayHintDecorations(state.doc.length, [
      {
        position: { line: 1, column: 12, offset: 11 },
        text: ': Value',
        kind: 'type',
      },
    ])
    const transaction = state.update({ changes: { from: 0, insert: '//' } })
    const mapped = mapWorkbenchInlayHintDecorationsThroughChanges(decorations, transaction.changes)
    const positions: number[] = []
    mapped.between(0, transaction.state.doc.length, (from) => positions.push(from))

    assert.deepEqual(positions, [13])
  })

  void test('does not duplicate the active buffer in background semantic requests', async () => {
    const editor = await readFile('src/renderer/src/components/editor/CodeMirrorEditor.tsx', 'utf8')

    assert.match(
      editor,
      /createWorkbenchSemanticTokensExtension\([\s\S]{0,520}openTabs:\s*openTabsLatest\.current\.filter\(\(tab\) => tab\.path !== path\)/u
    )
    assert.match(
      editor,
      /const siblingOpenTabs = currentOpenTabs\.filter\(\(tab\) => tab\.path !== path\)[\s\S]{0,820}openTabs: syncOpenFiles \? siblingOpenTabs : \[\]/u
    )
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
    assert.deepEqual(
      velar?.project?.commands.map((command) => command.id),
      [
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
      ]
    )
    remove()
  })
})

void describe('shared external LSP client', () => {
  void test('retracts a discarded dirty buffer from the server while omitted snapshots keep it', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-lsp-discard-')))
    const discardedPath = join(projectRoot, 'discarded.overlay')
    const discardedUri = pathToFileURL(discardedPath).toString()
    const remove = registerWorkbenchLanguageService({
      id: 'discarded-overlay-fixture',
      label: 'Discarded Overlay Fixture',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['overlay'],
      languages: ['discarded-overlay-fixture'],
      command: process.execPath,
      args: [fixture, 'documents'],
    })
    const services = new WorkbenchLanguageServices(languagePathResolver)
    const probe = async (request: Parameters<WorkbenchLanguageServices['getCompletions']>[0]) => {
      const result = await services.getCompletions(request)
      const detail = result.items[0]?.detail
      assert.ok(detail)
      return JSON.parse(detail) as {
        pid: number
        closedUris: string[]
        documents: Record<string, string>
      }
    }
    const activeRequest = {
      projectRoot,
      path: 'active.overlay',
      content: 'active buffer',
      position: { line: 1, column: 1 },
    }
    try {
      await writeFile(discardedPath, 'saved on disk', 'utf8')
      const dirty = await probe({
        ...activeRequest,
        openFiles: [{ path: 'discarded.overlay', content: 'discarded edit' }],
      })
      assert.equal(dirty.documents[discardedUri], 'discarded edit')

      // 滚动 inlay 省略快照：仍保留上次已同步的兄弟文件。
      const reused = await probe(activeRequest)
      assert.equal(reused.documents[discardedUri], 'discarded edit')
      assert.deepEqual(reused.closedUris, [])

      // 关闭并丢弃后，空 dirty 快照须让同一个服务器撤销旧文档。
      const discarded = await probe({ ...activeRequest, openFiles: [] })
      assert.equal(discarded.pid, dirty.pid)
      assert.equal(discarded.documents[discardedUri], undefined)
      assert.deepEqual(discarded.closedUris, [discardedUri])

      const reopened = await probe({
        projectRoot,
        path: 'discarded.overlay',
        position: { line: 1, column: 1 },
        openFiles: [],
      })
      assert.equal(reopened.pid, dirty.pid)
      assert.equal(reopened.documents[discardedUri], 'saved on disk')
      const diagnostics = await services.getDiagnostics({
        projectRoot,
        path: 'discarded.overlay',
        content: 'saved on disk',
        openFiles: [],
      })
      assert.deepEqual(
        diagnostics.diagnostics.map((diagnostic) => diagnostic.message),
        ['fake diagnostic']
      )
    } finally {
      await services.dispose()
      remove()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('isolates nested runtime roots and their file changes inside one workspace', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-nested-lsp-')))
    const workspaceRoot = join(fixtureRoot, 'workspace')
    const firstRoot = join(workspaceRoot, 'apps', 'first')
    const secondRoot = join(workspaceRoot, 'apps', 'second')
    const firstPath = join(firstRoot, 'src', 'main.nested')
    const secondPath = join(secondRoot, 'src', 'main.nested')
    await mkdir(dirname(firstPath), { recursive: true })
    await mkdir(dirname(secondPath), { recursive: true })
    await writeFile(join(fixtureRoot, 'runtime.json'), '{}\n', 'utf8')
    await writeFile(join(firstRoot, 'runtime.json'), '{}\n', 'utf8')
    await writeFile(join(secondRoot, 'runtime.json'), '{}\n', 'utf8')

    const descriptor = {
      id: 'nested-fixture-language',
      label: 'Nested Fixture Language',
      installKind: 'builtin' as const,
      runtime: 'lsp-server' as const,
      extensions: ['nested'],
      languages: ['nested-fixture-language'],
      command: process.execPath,
      args: [fixture, 'runtime-root'],
      projectRootMarkers: ['runtime.json'],
      documentLanguageId: 'nested-fixture-language',
    }
    const manager = new ExternalLspManager()
    const probe = async (
      client: ExternalLspClient,
      path: string
    ): Promise<{
      cwd: string
      rootUri: string
      workspaceFolders: Array<{ uri: string; name: string }>
      pid: number
      watchedUris: string[]
    }> => {
      const detail = (await client.completion(path, 'comp', { line: 0, character: 4 })).items[0]
        ?.detail
      assert.ok(detail)
      return JSON.parse(detail) as {
        cwd: string
        rootUri: string
        workspaceFolders: Array<{ uri: string; name: string }>
        pid: number
        watchedUris: string[]
      }
    }

    try {
      assert.equal(
        resolveExternalLspRuntimeRoot(workspaceRoot, firstPath, descriptor),
        await realpath(firstRoot)
      )
      assert.equal(
        resolveExternalLspRuntimeRoot(
          workspaceRoot,
          join(workspaceRoot, 'loose', 'main.nested'),
          descriptor
        ),
        await realpath(workspaceRoot),
        'a marker above the workspace boundary must not become the runtime root'
      )
      const dotDotOwnedRoot = join(workspaceRoot, '..owned')
      await mkdir(dotDotOwnedRoot, { recursive: true })
      await writeFile(join(dotDotOwnedRoot, 'runtime.json'), '{}\n', 'utf8')
      assert.equal(
        resolveExternalLspRuntimeRoot(
          workspaceRoot,
          join(dotDotOwnedRoot, 'src', 'main.nested'),
          descriptor
        ),
        await realpath(dotDotOwnedRoot),
        'a legitimate directory beginning with two dots remains inside the workspace'
      )
      const escapedRoot = join(workspaceRoot, 'escaped-runtime')
      await symlink(fixtureRoot, escapedRoot, process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(
        () =>
          resolveExternalLspRuntimeRoot(
            workspaceRoot,
            join(escapedRoot, 'main.nested'),
            descriptor
          ),
        /escapes the workspace/u
      )
      const escapedMarkerRoot = join(workspaceRoot, 'escaped-marker')
      await mkdir(escapedMarkerRoot, { recursive: true })
      await symlink(
        fixtureRoot,
        join(escapedMarkerRoot, 'runtime.json'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      assert.throws(
        () =>
          resolveExternalLspRuntimeRoot(
            workspaceRoot,
            join(escapedMarkerRoot, 'main.nested'),
            descriptor
          ),
        /项目根标记的真实路径超出工作区/u
      )
      const toolchainRoot = join(workspaceRoot, 'tools', 'owned')
      const toolchainPackage = join(toolchainRoot, 'node_modules', '@fixture', 'nested-lsp')
      await mkdir(toolchainPackage, { recursive: true })
      await writeFile(
        join(toolchainPackage, 'package.json'),
        '{"name":"@fixture/nested-lsp"}\n',
        'utf8'
      )
      assert.equal(
        resolveExternalLspRuntimeRoot(workspaceRoot, join(toolchainRoot, 'src', 'main.nested'), {
          ...descriptor,
          packageName: '@fixture/nested-lsp',
          projectNodePackageBin: 'nested-lsp',
          projectRootMarkers: [],
        }),
        await realpath(toolchainRoot)
      )

      const first = await manager.client(workspaceRoot, descriptor, firstPath)
      const second = await manager.client(workspaceRoot, descriptor, secondPath)
      assert.notEqual(first, second)

      const firstInitial = await probe(first, firstPath)
      const secondInitial = await probe(second, secondPath)
      assert.equal(await realpath(firstInitial.cwd), await realpath(firstRoot))
      assert.equal(firstInitial.rootUri, pathToFileURL(await realpath(firstRoot)).toString())
      assert.deepEqual(firstInitial.workspaceFolders, [
        {
          uri: pathToFileURL(await realpath(firstRoot)).toString(),
          name: 'first',
        },
      ])
      assert.equal(await realpath(secondInitial.cwd), await realpath(secondRoot))
      assert.equal(secondInitial.rootUri, pathToFileURL(await realpath(secondRoot)).toString())

      await manager.filesChanged(workspaceRoot, [firstPath, secondPath])
      const firstAfterChanges = await probe(first, firstPath)
      const secondAfterChanges = await probe(second, secondPath)
      assert.deepEqual(firstAfterChanges.watchedUris, [pathToFileURL(firstPath).toString()])
      assert.deepEqual(secondAfterChanges.watchedUris, [pathToFileURL(secondPath).toString()])

      await manager.invalidate(workspaceRoot)
      const restarted = await manager.client(workspaceRoot, descriptor, firstPath)
      assert.notEqual(restarted, first)
      assert.notEqual((await probe(restarted, firstPath)).pid, firstInitial.pid)
    } finally {
      await manager.dispose()
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  void test('reclaims obsolete nested clients when runtime ownership moves', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'workbench-moving-lsp-root-'))
    const workspaceRoot = join(fixtureRoot, 'workspace')
    const nestedRoot = join(workspaceRoot, 'app')
    const nestedPath = join(nestedRoot, 'src', 'main.moving')
    const siblingPath = join(workspaceRoot, 'shared', 'main.moving')
    const markerPath = join(nestedRoot, 'runtime.json')
    const movedMarkerPath = join(nestedRoot, 'runtime.moved.json')
    await mkdir(dirname(nestedPath), { recursive: true })
    await mkdir(dirname(siblingPath), { recursive: true })
    const descriptor = {
      id: 'moving-fixture-language',
      label: 'Moving Fixture Language',
      installKind: 'builtin' as const,
      runtime: 'lsp-server' as const,
      extensions: ['moving'],
      languages: ['moving-fixture-language'],
      command: process.execPath,
      args: [fixture, 'runtime-root'],
      projectRootMarkers: ['runtime.json'],
      documentLanguageId: 'moving-fixture-language',
    }
    const manager = new ExternalLspManager()
    const probeFor = async (
      client: ExternalLspClient,
      path: string
    ): Promise<{
      pid: number
      closedUris: string[]
    }> => {
      const detail = (await client.completion(path, 'comp', { line: 0, character: 4 })).items[0]
        ?.detail
      assert.ok(detail)
      return JSON.parse(detail) as { pid: number; closedUris: string[] }
    }
    const pidFor = async (client: ExternalLspClient, path: string): Promise<number> =>
      (await probeFor(client, path)).pid
    const isRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    try {
      const workspaceClient = await manager.client(workspaceRoot, descriptor, nestedPath)
      assert.equal(await manager.client(workspaceRoot, descriptor, siblingPath), workspaceClient)
      const workspacePid = await pidFor(workspaceClient, nestedPath)

      await writeFile(markerPath, '{}\n', 'utf8')
      const firstNestedClient = await manager.client(workspaceRoot, descriptor, nestedPath)
      const firstNestedPid = await pidFor(firstNestedClient, nestedPath)
      assert.notEqual(firstNestedClient, workspaceClient)
      assert.equal(isRunning(workspacePid), true, 'the sibling document still owns the root client')
      assert.deepEqual(
        (await probeFor(workspaceClient, siblingPath)).closedUris,
        [pathToFileURL(nestedPath).toString()],
        'moving a document to its nested runtime closes it in the shared root runtime'
      )

      await rename(markerPath, movedMarkerPath)
      await manager.filesChanged(workspaceRoot, [markerPath, movedMarkerPath])
      assert.equal(
        isRunning(firstNestedPid),
        false,
        'renaming the marker releases the nested client'
      )
      assert.equal(await manager.client(workspaceRoot, descriptor, nestedPath), workspaceClient)

      await rename(movedMarkerPath, markerPath)
      const secondNestedClient = await manager.client(workspaceRoot, descriptor, nestedPath)
      const secondNestedPid = await pidFor(secondNestedClient, nestedPath)
      assert.notEqual(secondNestedClient, firstNestedClient)

      await rm(markerPath)
      await manager.filesChanged(workspaceRoot, [markerPath])
      assert.equal(
        isRunning(secondNestedPid),
        false,
        'deleting the marker releases the nested client'
      )
      assert.equal(await manager.client(workspaceRoot, descriptor, nestedPath), workspaceClient)

      const toolchainRoot = join(workspaceRoot, 'toolchain-owned')
      const toolchainDocument = join(toolchainRoot, 'src', 'main.tool-moving')
      const toolchainPackage = join(toolchainRoot, 'node_modules', '@fixture', 'moving-lsp')
      await mkdir(dirname(toolchainDocument), { recursive: true })
      await mkdir(toolchainPackage, { recursive: true })
      await writeFile(
        join(toolchainPackage, 'package.json'),
        JSON.stringify({
          name: '@fixture/moving-lsp',
          bin: { 'moving-lsp': './server.cjs' },
        }),
        'utf8'
      )
      await writeFile(join(toolchainPackage, 'server.cjs'), await readFile(fixture), 'utf8')
      const toolchainDescriptor = {
        ...descriptor,
        id: 'moving-toolchain-fixture-language',
        extensions: ['tool-moving'],
        languages: ['moving-toolchain-fixture-language'],
        packageName: '@fixture/moving-lsp',
        command: 'moving-lsp',
        args: ['runtime-root'],
        projectNodePackageBin: 'moving-lsp',
        projectRootMarkers: [],
        documentLanguageId: 'moving-toolchain-fixture-language',
      }
      const toolchainClient = await manager.client(
        workspaceRoot,
        toolchainDescriptor,
        toolchainDocument
      )
      const toolchainPid = await pidFor(toolchainClient, toolchainDocument)
      await rm(toolchainPackage, { recursive: true, force: true })
      await manager.filesChanged(workspaceRoot, [join(toolchainPackage, 'package.json')])
      assert.equal(isRunning(toolchainPid), false, 'deleting the toolchain releases its client')
      assert.notEqual(
        await manager.client(workspaceRoot, toolchainDescriptor, toolchainDocument),
        toolchainClient
      )
    } finally {
      await manager.dispose()
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  void test('does not resurrect pending clients across manager disposal or workspace invalidation', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-manager-race-'))
    const workspaceRoot = join(fixtureRoot, 'workspace')
    const documentPath = join(workspaceRoot, 'src', 'main.racing')
    await mkdir(dirname(documentPath), { recursive: true })
    const descriptor = {
      id: 'racing-fixture-language',
      label: 'Racing Fixture Language',
      installKind: 'builtin' as const,
      runtime: 'lsp-server' as const,
      extensions: ['racing'],
      languages: ['racing-fixture-language'],
      command: process.execPath,
      args: [fixture],
      documentLanguageId: 'racing-fixture-language',
    }

    const disposedManager = new ExternalLspManager()
    const pendingDisposalClient = disposedManager.client(workspaceRoot, descriptor, documentPath)
    const disposalRejection = assert.rejects(pendingDisposalClient, /管理器已关闭/u)
    await disposedManager.dispose()
    await disposalRejection
    await assert.rejects(
      disposedManager.client(workspaceRoot, descriptor, documentPath),
      /管理器已关闭/u
    )

    const invalidatedManager = new ExternalLspManager()
    try {
      const pendingInvalidationClient = invalidatedManager.client(
        workspaceRoot,
        descriptor,
        documentPath
      )
      const invalidationRejection = assert.rejects(pendingInvalidationClient, /工作区已失效/u)
      await invalidatedManager.invalidate(workspaceRoot)
      await invalidationRejection

      const freshClient = await invalidatedManager.client(workspaceRoot, descriptor, documentPath)
      assert.equal(
        (await freshClient.completion(documentPath, 'comp', { line: 0, character: 4 })).items[0]
          ?.label,
        'component'
      )
    } finally {
      await invalidatedManager.dispose()
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  void test('keeps a refreshed client when ownership is reclaimed while reconciliation waits', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-refresh-reconcile-race-'))
    const workspaceRoot = join(fixtureRoot, 'workspace')
    const movingDocument = join(workspaceRoot, 'moving', 'main.refresh-race')
    const stableDocument = join(workspaceRoot, 'stable', 'main.refresh-race')
    const markerPath = join(dirname(movingDocument), 'runtime.json')
    const packagePath = join(workspaceRoot, 'package.json')
    await mkdir(dirname(movingDocument), { recursive: true })
    await mkdir(dirname(stableDocument), { recursive: true })
    await writeFile(packagePath, '{"dependencies":{}}\n', 'utf8')
    const descriptor = {
      id: 'refresh-reconcile-race-fixture-language',
      label: 'Refresh Reconcile Race Fixture Language',
      installKind: 'builtin' as const,
      runtime: 'lsp-server' as const,
      extensions: ['refresh-race'],
      languages: ['refresh-reconcile-race-fixture-language'],
      command: process.execPath,
      args: [fixture],
      projectRootMarkers: ['runtime.json'],
      documentLanguageId: 'refresh-reconcile-race-fixture-language',
    }
    const manager = new ExternalLspManager()
    let releaseOldClient = (): void => undefined

    try {
      const first = await manager.client(workspaceRoot, descriptor, movingDocument)
      assert.equal(
        (await first.completion(movingDocument, 'comp', { line: 0, character: 4 })).items[0]?.label,
        'component'
      )

      let markOldDisposeStarted = (): void => undefined
      const oldDisposeStarted = new Promise<void>((resolveStarted) => {
        markOldDisposeStarted = resolveStarted
      })
      const oldDisposeReleased = new Promise<void>((resolveReleased) => {
        releaseOldClient = resolveReleased
      })
      const originalDispose = first.dispose.bind(first)
      first.dispose = async (): Promise<void> => {
        markOldDisposeStarted()
        await oldDisposeReleased
        await originalDispose()
      }

      await writeFile(
        packagePath,
        '{"dependencies":{"@velarscript-labs/refresh-race":"0.1.0"}}\n',
        'utf8'
      )
      const pendingRefresh = manager.client(workspaceRoot, descriptor, stableDocument)
      await oldDisposeStarted

      await writeFile(markerPath, '{}\n', 'utf8')
      const pendingReconciliation = manager.filesChanged(workspaceRoot, [markerPath])
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
      releaseOldClient()

      const refreshed = await pendingRefresh
      await pendingReconciliation
      assert.notEqual(refreshed, first)
      assert.equal(
        (await refreshed.completion(stableDocument, 'comp', { line: 0, character: 4 })).items[0]
          ?.label,
        'component',
        'reconciliation must not dispose the replacement after its key regains an owner'
      )
      assert.equal(
        await manager.client(workspaceRoot, descriptor, stableDocument),
        refreshed,
        'the live replacement remains registered under the refreshed runtime key'
      )
    } finally {
      releaseOldClient()
      await manager.dispose()
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  void test('rejects project-local language bins whose real path leaves the workspace', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'workbench-escaped-lsp-bin-'))
    const workspaceRoot = join(fixtureRoot, 'workspace')
    const projectRoot = join(workspaceRoot, 'app')
    const packageRoot = join(projectRoot, 'node_modules', '@fixture', 'escaped-lsp')
    const outsidePackageRoot = join(fixtureRoot, 'outside-package')
    const documentPath = join(projectRoot, 'src', 'main.escaped')
    await mkdir(dirname(documentPath), { recursive: true })
    await mkdir(dirname(packageRoot), { recursive: true })
    await mkdir(outsidePackageRoot, { recursive: true })
    await writeFile(join(projectRoot, 'runtime.json'), '{}\n', 'utf8')
    await writeFile(
      join(outsidePackageRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/escaped-lsp',
        bin: { 'escaped-lsp': './server.cjs' },
      }),
      'utf8'
    )
    await writeFile(join(outsidePackageRoot, 'server.cjs'), await readFile(fixture), 'utf8')
    await symlink(
      outsidePackageRoot,
      packageRoot,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const manager = new ExternalLspManager()
    const descriptor = {
      id: 'escaped-bin-fixture-language',
      label: 'Escaped Bin Fixture Language',
      installKind: 'builtin' as const,
      runtime: 'lsp-server' as const,
      extensions: ['escaped'],
      languages: ['escaped-bin-fixture-language'],
      packageName: '@fixture/escaped-lsp',
      command: 'escaped-lsp',
      projectNodePackageBin: 'escaped-lsp',
      projectRootMarkers: ['runtime.json'],
      documentLanguageId: 'escaped-bin-fixture-language',
    }

    try {
      const client = await manager.client(workspaceRoot, descriptor, documentPath)
      await assert.rejects(
        client.completion(documentPath, 'comp', { line: 0, character: 4 }),
        /语言服务器不可用/u
      )

      const genericRoot = join(workspaceRoot, 'generic')
      const outsideBinRoot = join(fixtureRoot, 'outside-bin')
      const genericDocumentPath = join(genericRoot, 'src', 'main.generic-escaped')
      const genericCommandName = 'escaped-generic-lsp'
      const genericExecutableName =
        process.platform === 'win32' ? `${genericCommandName}.cmd` : genericCommandName
      await mkdir(dirname(genericDocumentPath), { recursive: true })
      await mkdir(join(genericRoot, 'node_modules'), { recursive: true })
      await mkdir(outsideBinRoot, { recursive: true })
      await writeFile(join(genericRoot, 'runtime.json'), '{}\n', 'utf8')
      await writeFile(join(outsideBinRoot, genericExecutableName), 'not executed\n', 'utf8')
      await symlink(
        outsideBinRoot,
        join(genericRoot, 'node_modules', '.bin'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      const genericClient = await manager.client(
        workspaceRoot,
        {
          ...descriptor,
          id: 'generic-escaped-bin-fixture-language',
          extensions: ['generic-escaped'],
          languages: ['generic-escaped-bin-fixture-language'],
          packageName: undefined,
          projectNodePackageBin: undefined,
          command: genericCommandName,
          documentLanguageId: 'generic-escaped-bin-fixture-language',
        },
        genericDocumentPath
      )
      await assert.rejects(
        genericClient.completion(genericDocumentPath, 'comp', { line: 0, character: 4 }),
        /真实路径超出工作区/u
      )
    } finally {
      await manager.dispose()
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  void test('resolves the nearest ancestor Node toolchain for nested projects', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workbench-ancestor-lsp-'))
    const projectRoot = join(workspaceRoot, 'packages', 'server')
    const binRoot = join(workspaceRoot, 'node_modules', '.bin')
    const commandName = 'ancestor-fixture-lsp'
    const command = join(binRoot, process.platform === 'win32' ? `${commandName}.cmd` : commandName)
    await mkdir(projectRoot, { recursive: true })
    await mkdir(binRoot, { recursive: true })
    await writeFile(
      command,
      process.platform === 'win32'
        ? `@"${process.execPath}" "${fixture}" %*\r\n`
        : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
      'utf8'
    )
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
      assert.deepEqual(
        diagnostics.map((item) => item.code),
        ['VEL5001']
      )
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
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/language-server',
        bin: { 'fixture-lsp': './server.cjs' },
      }),
      'utf8'
    )
    await writeFile(join(packageRoot, 'server.cjs'), await readFile(fixture), 'utf8')
    await writeFile(
      command,
      process.platform === 'win32'
        ? '@echo off\r\nexit /b 77\r\n'
        : '#!/usr/bin/env __workbench_missing_node__\n',
      'utf8'
    )
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
      assert.deepEqual(
        diagnostics.map((item) => item.code),
        ['VEL5001']
      )
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
        (
          await first.completion(join(projectRoot, 'main.refresh'), 'comp', {
            line: 0,
            character: 4,
          })
        ).items[0]?.label,
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
        (
          await refreshed.completion(join(projectRoot, 'main.refresh'), 'comp', {
            line: 0,
            character: 4,
          })
        ).items[0]?.label,
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
    const definitions = await client.definition(path, 'component App:\n', {
      line: 0,
      character: 11,
    })
    const references = await client.references(path, 'component App:\n', { line: 0, character: 11 })
    const documentHighlights = await client.documentHighlights(path, 'component App:\n', {
      line: 0,
      character: 11,
    })
    const rename = await client.rename(
      path,
      'component App:\n',
      { line: 0, character: 11 },
      'Shell'
    )
    const symbols = await client.documentSymbols(path, 'component App:\n')
    const signature = await client.signatureHelp(path, 'mount(', { line: 0, character: 6 })
    const hints = await client.inlayHints(path, 'component App:\n', {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 0 },
    })
    const edits = await client.format(path, 'component App:\n')

    assert.deepEqual(
      diagnostics.map((item) => item.code),
      ['VEL5001']
    )
    assert.equal(completions.items[0]?.label, 'component')
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
    const suppressedHover = await services.getHover({
      ...request,
      position: { line: 1, column: 2 },
    })
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
      diagnostics: [
        {
          path: 'main.fakevel',
          severity: 'error',
          message: 'fake diagnostic',
          source: 'fake-velar',
          code: 'VEL5001',
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
        },
      ],
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
    assert.deepEqual(semanticTokens.tokens, [
      {
        range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 14 },
        type: 'class',
        modifiers: ['declaration', 'frameworkDefinition'],
      },
    ])
    assert.equal(codeActions.actions[0]?.title, 'Apply fake quick fix')
    assert.equal(codeActions.actions[0]?.changes[0]?.edits[0]?.newText, 'let')
    assert.deepEqual(hints.hints[0]?.position, { line: 1, column: 14, offset: 13 })
    // 编辑器只按偏移放提示：外部语言服务器的提示也得真的变成装饰。
    const hintPositions: number[] = []
    buildWorkbenchInlayHintDecorations('component App:\n'.length, hints.hints).between(
      0,
      15,
      (from) => {
        hintPositions.push(from)
      }
    )
    assert.deepEqual(hintPositions, [13])

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
    const retryCommand = join(
      retryRoot,
      process.platform === 'win32' ? 'retry-lsp.cmd' : 'retry-lsp'
    )
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
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`
        : `#!/bin/sh\nexec "${process.execPath.replaceAll('"', '\\"')}" "${fixture.replaceAll('"', '\\"')}"\n`,
      'utf8'
    )
    if (process.platform !== 'win32') await chmod(retryCommand, 0o755)
    const recoveredCompletions = await retriable.completion(
      join(retryRoot, 'probe.retry'),
      'comp',
      { line: 0, character: 4 }
    )
    assert.equal(recoveredCompletions.items[0]?.label, 'component')
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
      oversized.completion(`${projectRoot}/tests/probe.bounded`, 'const value = 1\n', {
        line: 0,
        character: 1,
      }),
      /16 MiB/u
    )
    await oversized.dispose()

    const hanging = new ExternalLspClient(
      projectRoot,
      {
        id: 'hanging-fixture-language',
        label: 'Hanging Fixture Language',
        installKind: 'builtin',
        runtime: 'lsp-server',
        extensions: ['hanging'],
        languages: ['hanging'],
        command: process.execPath,
        args: [fixture, 'hang'],
        documentLanguageId: 'hanging',
      },
      500
    )
    await assert.rejects(
      hanging.completion(`${projectRoot}/tests/probe.hanging`, 'const value = 1\n', {
        line: 0,
        character: 1,
      }),
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

    assert.ok(
      diagnostics.diagnostics.some(
        (item) =>
          item.code === 'reportAssignmentType' &&
          /not assignable to declared type "str"/iu.test(item.message)
      )
    )
    assert.match(JSON.stringify(hover), /str/u)

    // Pyright 的悬浮说明是「```python 签名```、---、说明」：签名与说明分开画，不漏出 Markdown 标记。
    const documented = [
      'def greet(name: str) -> str:',
      '    """Say *hello*.',
      '',
      '    Args:',
      '        name: who to greet',
      '    """',
      '    return name',
      '',
    ].join('\n')
    const functionHover = await services.getHover({
      projectRoot,
      path: 'pyright-hover-probe.py',
      content: documented,
      position: { line: 1, column: 6 },
    })
    assert.match(
      functionHover.hover?.displayText ?? '',
      /^\(function\) def greet\(name: str\) -> str$/u
    )
    assert.doesNotMatch(
      JSON.stringify(functionHover.hover?.documentationBlocks),
      /```|---|&nbsp;|\\\\\*/u
    )
    assert.match(functionHover.hover?.documentation ?? '', /Say \*hello\*\./u)
    await services.dispose()
  })
})
