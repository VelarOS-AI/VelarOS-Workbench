import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import vm from 'node:vm'

import { test } from 'bun:test'
import type { JumpListCategory, JumpListItem } from 'electron'
import ts from 'typescript'

import type { WorkbenchRecentProject } from '../src/shared/projectHub'

const source = readFileSync(
  new URL('../src/main/projects/WorkbenchWindowsJumpList.ts', import.meta.url),
  'utf8'
)
const executable = ts.transpile(source, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
})

function fixture(packaged = true, platform = 'win32') {
  const updates: JumpListCategory[][] = []
  let projects: WorkbenchRecentProject[] = []
  let removedItems: JumpListItem[] = []
  let changed = (): void => {}
  let localeChanged = (): void => {}
  let label = '最近项目'
  const context = vm.createContext({
    exports: {},
    process: { platform, execPath: 'C:\\Workbench\\Workbench.exe', cwd: () => 'C:\\Dev Workbench' },
    console,
    require: (name: string) => {
      if (name === 'node:path') return { dirname }
      if (name === 'electron')
        return {
          app: {
            isPackaged: packaged,
            getAppPath: () => 'C:\\Dev Workbench',
            getJumpListSettings: () => ({ removedItems }),
            setJumpList: (categories: JumpListCategory[]) => {
              updates.push(JSON.parse(JSON.stringify(categories)) as JumpListCategory[])
              removedItems = []
              return 'ok'
            },
          },
        }
      if (name.includes('workbenchMainLocale'))
        return {
          onWorkbenchMainLocaleChanged: (listener: () => void) => {
            localeChanged = listener
          },
        }
      if (name.includes('workbenchMainMessages')) return { workbenchMainText: () => label }
      throw new Error(`Unexpected import ${name}`)
    },
  })
  vm.runInContext(executable, context)
  const install = (
    context.exports as {
      installWorkbenchWindowsJumpList: (windows: unknown) => void
    }
  ).installWorkbenchWindowsJumpList
  return {
    updates,
    install: () =>
      install({
        getRecentProjects: () => projects,
        onChanged: (listener: () => void) => {
          changed = listener
        },
      }),
    change: (next: WorkbenchRecentProject[]) => {
      projects = next
      changed()
    },
    remove: (items: JumpListItem[]) => {
      removedItems = items
      changed()
    },
    locale: (next: string) => {
      label = next
      localeChanged()
    },
  }
}

const project: WorkbenchRecentProject = {
  path: 'D:\\项目 with spaces',
  name: '项目 with spaces',
  lastOpenedAt: 1,
  missing: false,
}

test('Windows recent projects use project names and launch quoted directory arguments', () => {
  const view = fixture()
  view.change([
    project,
    { ...project, path: 'C:\\', name: 'C:', lastOpenedAt: 2 },
    { ...project, name: 'missing', missing: true },
  ])
  view.install()
  const category = view.updates[0]![0]!
  assert.equal(category.name, '最近项目')
  assert.deepEqual(
    category.items?.map((item) => item.title),
    ['项目 with spaces', 'C:']
  )
  assert.equal(category.items?.[0]?.args, '"D:\\项目 with spaces"')
  assert.equal(category.items?.[1]?.args, '"C:\\\\"')
  assert.equal(category.items?.[0]?.description, project.path)
  view.change([project])
  const before = view.updates.length
  view.change([project])
  assert.equal(view.updates.length, before, 'focus alone does not rewrite the shell list')
  view.locale('Recent Projects')
  assert.equal(view.updates.at(-1)?.[0]?.name, 'Recent Projects')
  view.change([])
  assert.deepEqual(view.updates.at(-1), [])
})

test('development entries include the app entry and preserve the development working directory', () => {
  const view = fixture(false)
  view.change([project])
  view.install()
  const item = view.updates[0]?.[0]?.items?.[0]
  assert.equal(item?.args, '"C:\\Dev Workbench" "D:\\项目 with spaces"')
  assert.equal(item?.workingDirectory, 'C:\\Dev Workbench')
})

test('shell removals stay hidden across refreshes until the project is explicitly reopened', () => {
  const view = fixture()
  view.change([project])
  view.install()
  view.remove([view.updates[0]![0]!.items![0]!])
  assert.deepEqual(view.updates.at(-1), [])
  view.change([project])
  assert.deepEqual(view.updates.at(-1), [])
  view.change([{ ...project, lastOpenedAt: 2 }])
  assert.equal(view.updates.at(-1)?.[0]?.items?.[0]?.title, project.name)
})

test('other platforms do not install a Windows jump list', () => {
  const view = fixture(true, 'darwin')
  view.change([project])
  view.install()
  view.locale('Recent Projects')
  assert.deepEqual(view.updates, [])
})
