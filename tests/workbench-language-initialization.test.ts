import assert from 'node:assert/strict'
import { join } from 'node:path'

import { test } from 'bun:test'

import { acquireTypeScriptLanguageService, normalizeTypeScriptFileName } from '../src/main/workspace/language/TypeScriptProjectHost'

import { createLanguageProject } from './helpers/languageProject'

test('a narrow web config wins over an overlapping workspace-wide config', async () => {
  const project = await createLanguageProject({
    'package.json': '{"type":"module"}',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext' }, include: ['src/**/*.ts'] }),
    'tsconfig/web.json': JSON.stringify({ compilerOptions: { target: 'ESNext', strict: true }, include: ['../src/web/**/*.ts'] }),
    'src/web/main.ts': 'export const message = "hello"\n',
    'src/node/server.ts': 'export const server = true\n',
  })
  try {
    const file = join(project.projectRoot, 'src', 'web', 'main.ts')
    const snapshot = acquireTypeScriptLanguageService(project.projectRoot, file, [file], new Map())
    assert.equal(snapshot.config.configPath, normalizeTypeScriptFileName(join(project.projectRoot, 'tsconfig', 'web.json')))
    assert.equal(snapshot.files.has(normalizeTypeScriptFileName(join(project.projectRoot, 'src/node/server.ts'))), false)
  } finally {
    await project.dispose()
  }
})

test('hover avoids unused dependency declarations while completion can still discover their exports', async () => {
  const content = 'export const localValue = 1\npackageFixture\n'
  const project = await createLanguageProject({
    'package.json': JSON.stringify({ type: 'module', devDependencies: { 'fixture-package': '1.0.0' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src/**/*.ts'] }),
    'src/main.ts': content,
    'node_modules/fixture-package/package.json': JSON.stringify({ name: 'fixture-package', version: '1.0.0', types: './index.d.ts' }),
    'node_modules/fixture-package/index.d.ts': 'export declare function packageFixture(): void\n',
  })
  try {
    const request = { projectRoot: project.projectRoot, path: 'src/main.ts', content }
    const hover = await project.services.getHover({ ...request, position: { line: 1, column: 17 } })
    assert.ok(hover.hover)
    const file = join(project.projectRoot, 'src', 'main.ts')
    const snapshot = acquireTypeScriptLanguageService(project.projectRoot, file, [file], new Map())
    const dependency = normalizeTypeScriptFileName(join(project.projectRoot, 'node_modules/fixture-package/index.d.ts'))
    assert.equal(snapshot.files.has(dependency), false)
    const completions = await project.services.getCompletions({ ...request, position: { line: 2, column: 15 } })
    assert.ok(completions.items.some((item) => item.label === 'packageFixture'))
    assert.equal(snapshot.files.has(dependency), true)
  } finally {
    await project.dispose()
  }
}, 15_000)
