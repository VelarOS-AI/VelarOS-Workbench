import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, test } from 'bun:test'
import * as ts from 'typescript'

import {
  clearWorkbenchProjectEslintCache,
  clearWorkbenchProjectEslintResults,
  getWorkbenchJavaScriptLintDiagnostics,
} from '../src/main/workspace/language/JavaScriptLinting'
import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import {
  buildTypeScriptDocumentSymbols,
  rangeFromTextSpanInContent,
} from '../src/main/workspace/language/TypeScriptLanguageFeatures'
import {
  acquireTypeScriptLanguageService,
  clearTypeScriptProjectCache,
  normalizeTypeScriptFileName,
  refreshTypeScriptProjectFilesFromDisk,
} from '../src/main/workspace/language/TypeScriptProjectHost'
import { PathResolver } from '../src/main/workspace/PathResolver'

async function createTypeScriptProject(): Promise<{ projectRoot: string; mainPath: string }> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-language-hot-paths-')))
  await mkdir(join(projectRoot, 'src'), { recursive: true })
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await writeFile(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ESNext', strict: true },
      include: ['src/**/*.ts'],
    }),
    'utf8'
  )
  const mainPath = join(projectRoot, 'src', 'main.ts')
  await writeFile(mainPath, 'export const count = 1\nexport const total = count + count\n', 'utf8')
  return { projectRoot, mainPath }
}

void describe('language service hot paths', () => {
  void test('maps spans through one cached line table instead of re-parsing the file per symbol', () => {
    const lines: string[] = []
    for (let index = 0; index < 2_000; index += 1) lines.push(`export function fn${index}(): number { return ${index} }`)
    const content = `${lines.join('\n')}\n`
    const fileName = '/virtual/many-symbols.ts'
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, strict: true }),
      getScriptFileNames: () => [fileName],
      getScriptVersion: () => '1',
      getScriptSnapshot: (name) => name === fileName ? ts.ScriptSnapshot.fromString(content) : undefined,
      getCurrentDirectory: () => '/virtual',
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (name) => name === fileName,
      readFile: (name) => (name === fileName ? content : undefined),
    }
    const service = ts.createLanguageService(host)
    try {
      const started = performance.now()
      const symbols = buildTypeScriptDocumentSymbols({ service, fileName, content })
      const elapsed = performance.now() - started
      // 每个函数只列一次，行号与声明行一致。
      assert.equal(symbols.length, 2_000)
      const lineByName = new Map(symbols.map((symbol) => [symbol.name, symbol.line]))
      assert.equal([...lineByName.keys()].filter((name) => name.startsWith('fn')).length, 2_000)
      assert.deepEqual([0, 1, 2, 3, 4].map((index) => lineByName.get(`fn${index}`)), [1, 2, 3, 4, 5])
      assert.equal(lineByName.get('fn1999'), 2_000)
      // 以前每个符号都重新解析整个文件，2000 个符号要十几秒；现在只查一次行首表。
      assert.ok(elapsed < 2_000, `document symbols took ${elapsed.toFixed(0)} ms`)

      const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
      for (const span of [{ start: 0, length: 6 }, { start: 120, length: 3 }, { start: content.length - 2, length: 1 }]) {
        const expectedStart = sourceFile.getLineAndCharacterOfPosition(span.start)
        const expectedEnd = sourceFile.getLineAndCharacterOfPosition(span.start + span.length)
        assert.deepEqual(rangeFromTextSpanInContent(content, fileName, span), {
          startLine: expectedStart.line + 1,
          startColumn: expectedStart.character + 1,
          endLine: expectedEnd.line + 1,
          endColumn: expectedEnd.character + 1,
        })
      }
      assert.equal(rangeFromTextSpanInContent(content, fileName, { start: content.length, length: 1 }), null)
    } finally {
      service.dispose()
    }
  })

  void test('returns TypeScript document highlights instead of failing on the files-to-search argument', async () => {
    const { projectRoot } = await createTypeScriptProject()
    const services = new WorkbenchLanguageServices(new PathResolver())
    try {
      const result = await services.getDocumentHighlights({
        projectRoot,
        path: 'src/main.ts',
        language: 'typescript',
        content: 'export const count = 1\nexport const total = count + count\n',
        position: { line: 1, column: 15 },
      })
      assert.deepEqual(
        result.highlights.map((highlight) => [highlight.range.startLine, highlight.range.startColumn, highlight.kind]),
        // 声明处带初始化，TypeScript 记作写；两处使用是读。
        [[1, 14, 'write'], [2, 22, 'read'], [2, 30, 'read']]
      )
    } finally {
      await services.dispose()
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('adds and removes root files incrementally instead of rebuilding the project', async () => {
    const { projectRoot, mainPath } = await createTypeScriptProject()
    const extraPath = join(projectRoot, 'src', 'extra.ts')
    const content = 'export const count = 1\nexport const total = count + count\n'
    const acquire = () => acquireTypeScriptLanguageService(projectRoot, mainPath, [mainPath], new Map([[mainPath, content]]))
    try {
      const first = acquire()
      assert.equal(first.files.has(normalizeTypeScriptFileName(extraPath)), false)

      // 新文件落盘但还没人通知：记住的配置照用，不为每次请求重扫目录。
      await writeFile(extraPath, 'export const extra = 2\n', 'utf8')
      assert.equal(acquire().files.has(normalizeTypeScriptFileName(extraPath)), false)

      refreshTypeScriptProjectFilesFromDisk(projectRoot, [extraPath])
      const withExtra = acquire()
      assert.equal(withExtra.files.has(normalizeTypeScriptFileName(extraPath)), true)
      assert.equal(withExtra.service, first.service, 'the language service must be kept, not rebuilt')
      assert.equal(withExtra.service.getProgram()?.getSourceFile(extraPath)?.text, 'export const extra = 2\n')

      await rm(extraPath)
      refreshTypeScriptProjectFilesFromDisk(projectRoot, [extraPath])
      const withoutExtra = acquire()
      assert.equal(withoutExtra.files.has(normalizeTypeScriptFileName(extraPath)), false)
      assert.equal(withoutExtra.service, first.service)

      // 配置文件变了才整体重建。
      await writeFile(
        join(projectRoot, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ESNext', strict: false },
          include: ['src/**/*.ts'],
        }),
        'utf8'
      )
      refreshTypeScriptProjectFilesFromDisk(projectRoot, [join(projectRoot, 'tsconfig.json')])
      const rebuilt = acquire()
      assert.notEqual(rebuilt.service, first.service)
      assert.equal(rebuilt.compilerOptions.strict, false)
    } finally {
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('reuses ESLint results until disk changes and reloads changed project rules', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-eslint-cache-')))
    const eslintPackage = resolve(process.cwd(), 'node_modules', 'eslint')
    const absolutePath = join(projectRoot, 'main.js')
    const services = new WorkbenchLanguageServices(new PathResolver())
    const input = (content: string) => ({ projectRoot, absolutePath, relativePath: 'main.js', content })
    try {
      await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
      await symlink(eslintPackage, join(projectRoot, 'node_modules', 'eslint'), 'dir')
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
      await writeFile(
        join(projectRoot, 'eslint.config.js'),
        "export default [{ files: ['**/*.js'], rules: { 'no-unused-vars': 'error' } }]\n",
        'utf8'
      )

      const first = await getWorkbenchJavaScriptLintDiagnostics(input('const unused = 1\n'))
      assert.equal(first.length, 1, JSON.stringify(first))
      assert.match(first[0]!.message, /no-unused-vars/u)

      const repeated = await getWorkbenchJavaScriptLintDiagnostics(input('const unused = 1\n'))
      assert.equal(repeated, first, 'identical text must hit the cache')

      const edited = await getWorkbenchJavaScriptLintDiagnostics(input('export const used = 1\n'))
      assert.deepEqual(edited, [])

      clearWorkbenchProjectEslintResults(projectRoot)
      const afterChange = await getWorkbenchJavaScriptLintDiagnostics(input('const unused = 1\n'))
      assert.notEqual(afterChange, first, 'a disk change must invalidate the cached result')
      assert.deepEqual(afterChange, first)

      const configPath = join(projectRoot, 'eslint.config.js')
      await writeFile(configPath, "export default [{ files: ['**/*.js'], rules: {} }]\n", 'utf8')
      // ESLint 以毫秒 mtime 标记配置模块；保证这次编辑与首次读取是两个版本。
      const changedAt = new Date(Date.now() + 1_000)
      await utimes(configPath, changedAt, changedAt)
      await services.projectFilesChanged({ projectRoot, paths: ['eslint.config.js'] })
      assert.deepEqual(await getWorkbenchJavaScriptLintDiagnostics(input('const unused = 1\n')), [])
    } finally {
      await services.dispose()
      clearWorkbenchProjectEslintCache(projectRoot)
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('a workspace rescan reloads Prettier data configuration and EditorConfig', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-prettier-cache-')))
    const services = new WorkbenchLanguageServices(new PathResolver())
    const configPath = join(projectRoot, '.prettierrc.json')
    const editorConfigPath = join(projectRoot, '.editorconfig')
    const request = {
      projectRoot,
      path: 'main.ts',
      content: 'const x={alpha:1,beta:2}\n',
    }
    const formatted = async () =>
      (await services.getFormat(request)).changes[0]?.edits[0]?.newText ?? ''
    try {
      await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
      await symlink(
        resolve(process.cwd(), 'node_modules', 'prettier'),
        join(projectRoot, 'node_modules', 'prettier'),
        'dir'
      )
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
      await writeFile(configPath, JSON.stringify({ printWidth: 20, semi: true }), 'utf8')
      await writeFile(
        editorConfigPath,
        'root = true\n[*]\nindent_style = space\nindent_size = 2\n',
        'utf8'
      )
      const before = await formatted()
      assert.match(before, /\n {2}alpha: 1/u)
      assert.ok(before.endsWith('};\n'))

      await writeFile(configPath, JSON.stringify({ printWidth: 20, semi: false }), 'utf8')
      await writeFile(
        editorConfigPath,
        'root = true\n[*]\nindent_style = space\nindent_size = 4\n',
        'utf8'
      )
      await services.projectFilesChanged({ projectRoot, paths: ['.'] })
      const after = await formatted()
      assert.match(after, /\n {4}alpha: 1/u)
      assert.ok(after.endsWith('}\n'))
    } finally {
      await services.invalidateProject({ projectRoot })
      await services.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
