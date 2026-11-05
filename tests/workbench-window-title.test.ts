import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { test } from 'bun:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'getWorkbenchWindowTitle'
)
assert.ok(declaration, 'title function must exist')
const executable = ts.transpile(declaration.getText(ast), {
  target: ts.ScriptTarget.ES2022,
})

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`window title preserves ${platform} policy for project changes and no project`, () => {
    for (const fallback of ['VelarOS Workbench', 'VelarOS Workbench Dev']) {
      const context = vm.createContext({
        process: { platform },
        WorkbenchApplicationName: fallback,
      })
      vm.runInContext(executable, context)
      for (const name of [null, undefined, '', 'project-a', '项目 B']) {
        context.projectName = name
        assert.equal(
          vm.runInContext('getWorkbenchWindowTitle(projectName)', context),
          platform === 'win32' ? 'VelarOS WorkBench' : (name ?? fallback)
        )
      }
    }
  })
}

test('initial title, project updates and renderer title protection retain one main-process authority', () => {
  assert.match(
    source,
    /title: getWorkbenchWindowTitle\(hub\.getState\(\)\.currentProject\?\.name \?\? null\)/u
  )
  assert.match(
    source,
    /window\.setTitle\(getWorkbenchWindowTitle\(state\.currentProject\?\.name \?\? null\)\)/u
  )
  assert.match(
    source,
    /window\.on\('page-title-updated', \(event\) => \{\s*event\.preventDefault\(\)/u
  )
  assert.match(source, /if \(window\.isDestroyed\(\)\) return/u)
  assert.match(source, /window\.on\('closed', unsubscribeTitleSync\)/u)
})
