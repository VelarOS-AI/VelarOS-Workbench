import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { afterAll, beforeAll, describe, test } from 'bun:test'

import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'
import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import { clearTypeScriptProjectCache } from '../src/main/workspace/language/TypeScriptProjectHost'

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

const languagePathResolver = {
  async resolveProjectRoot(input: string): Promise<string> {
    return realpath(resolve(input))
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    return (relative(projectRoot, absolutePath) || '.').replaceAll('\\', '/')
  },
}

/** `§` 标出光标，换成 1 基行列。 */
function positionOf(text: string): { content: string; position: { line: number; column: number } } {
  const offset = text.indexOf('§')
  const content = text.replace('§', '')
  const before = content.slice(0, offset)
  return {
    content,
    position: { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') },
  }
}

let projectRoot = ''
let services: WorkbenchLanguageServices

async function completions(path: string, text: string) {
  const { content, position } = positionOf(text)
  return services.getCompletions({ projectRoot, path, content, position })
}

beforeAll(async () => {
  projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-completion-items-')))
  await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'] },
    include: ['src'],
  }))
  await mkdir(join(projectRoot, 'src'))
  await writeFile(join(projectRoot, 'src/theme.ts'), 'export function useTheme(): string { return "x" }\n')
  services = new WorkbenchLanguageServices(languagePathResolver, new ExternalLspProcessHost())
})

afterAll(async () => {
  await services.dispose()
  clearTypeScriptProjectCache(projectRoot)
  await rm(projectRoot, { recursive: true, force: true })
})

void describe('TypeScript completion items', () => {
  void test('returns the whole member list instead of the first 120 entries', async () => {
    const result = await completions('src/main.ts', 'document.§')
    assert.ok(result.items.length > 120, String(result.items.length))
    const querySelector = result.items.find((item) => item.label === 'querySelector')
    assert.equal(querySelector?.kind, 'method')
    // 同一优先级里按名字排：CodeMirror 用 sortText 排同分的候选。
    assert.match(querySelector?.sortText ?? '', / querySelector$/u)
  })

  void test('keeps the replacement span of optional-chain and import-statement completions', async () => {
    const optional = await completions('src/main.ts', 'declare const o: { foo: number } | undefined\no.§')
    assert.deepEqual(optional.items.find((item) => item.label === 'foo'), {
      label: 'foo',
      kind: 'property',
      detail: 'declare',
      returnType: undefined,
      insertText: '?.foo',
      range: { startLine: 2, startColumn: 2, endLine: 2, endColumn: 3 },
      sortText: '11 foo',
      filterText: undefined,
      isSnippet: undefined,
      resolve: undefined,
    })

    const statement = await completions('src/main.ts', 'import useTh§')
    const useTheme = statement.items.find((item) => item.label === 'useTheme')
    assert.equal(useTheme?.insertText, "import { useTheme$1 } from './theme';")
    assert.equal(useTheme?.isSnippet, true)
    assert.deepEqual(useTheme?.range, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 13 })
  })

  void test('resolves the auto-import edit when the completion is accepted', async () => {
    const { content, position } = positionOf('const value = 1\nuseThe§')
    const result = await services.getCompletions({ projectRoot, path: 'src/main.ts', content, position })
    const useTheme = result.items.find((item) => item.label === 'useTheme')
    assert.ok(useTheme?.resolve, 'auto-import candidates carry the data to resolve their import later')
    assert.equal(useTheme.additionalTextEdits, undefined)

    const resolved = await services.resolveCompletion({
      projectRoot,
      path: 'src/main.ts',
      content,
      position,
      item: useTheme.resolve,
    })
    // 导入语句跟着文件的写法走（这个文件不写分号）。
    assert.deepEqual(resolved.additionalTextEdits, [{
      path: 'src/main.ts',
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      newText: "import { useTheme } from './theme'\n\n",
    }])
  })
})

void describe('CSS and HTML completion items', () => {
  void test('keep snippets, replacement ranges and the whole property list', async () => {
    const css = await completions('styles/app.css', 'a { col§ }')
    assert.ok(css.items.length > 120)
    assert.deepEqual(
      (({ insertText, isSnippet, range, retrigger }) => ({ insertText, isSnippet, range, retrigger }))(
        css.items.find((item) => item.label === 'color')!
      ),
      {
        insertText: 'color: $0;',
        isSnippet: true,
        range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 8 },
        retrigger: true,
      }
    )

    const html = await completions('index.html', '<div cla§></div>')
    const attribute = html.items.find((item) => item.label === 'class')
    assert.equal(attribute?.insertText, 'class="$1"')
    assert.equal(attribute?.isSnippet, true)
  })
})
