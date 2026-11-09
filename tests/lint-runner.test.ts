import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import tsParser from '@typescript-eslint/parser'
import { test } from 'bun:test'
import { ESLint } from 'eslint'
import importSort from 'eslint-plugin-simple-import-sort'
import unusedImports from 'eslint-plugin-unused-imports'
import ts from 'typescript'

import { applyTypedLintFixes } from '../scripts/checks/lintFixes.mjs'

test('typed lint fixes use one source snapshot and fresh diagnostics after overlapping import fixes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-lint-fixes-'))
  const file = path.join(root, 'input.ts')
  const source = `\uFEFF${[
    "import { z } from './z'",
    "import { ignored } from './unused'",
    "import type { A } from './a'",
    '',
    'export const value: A = z',
    '',
  ].join('\n')}`
  try {
    await Promise.all([
      writeFile(file, source),
      writeFile(path.join(root, 'a.ts'), 'export type A = number\n'),
      writeFile(path.join(root, 'z.ts'), 'export const z = 1\n'),
      writeFile(path.join(root, 'unused.ts'), 'export const ignored = 0\n'),
    ])
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      noLib: true,
      types: [],
    }
    assert.ok(importSort && unusedImports)
    const lint = async (program: ts.Program) => {
      const engine = new ESLint({
        cwd: root,
        fix: false,
        overrideConfigFile: true,
        overrideConfig: [{
          files: ['**/*.ts'],
          languageOptions: {
            parser: tsParser,
            parserOptions: { project: false, programs: [program] },
          },
          plugins: { 'simple-import-sort': importSort, 'unused-imports': unusedImports },
          rules: {
            'simple-import-sort/imports': 'error',
            'unused-imports/no-unused-imports': 'error',
          },
        }],
      })
      return engine.lintFiles([file])
    }
    const program = ts.createProgram([file], options)
    const results = await lint(program)
    const sortFix = results[0]!.messages.find((message) =>
      message.ruleId === 'simple-import-sort/imports')?.fix
    const unusedFix = results[0]!.messages.find((message) =>
      message.ruleId === 'unused-imports/no-unused-imports')?.fix
    assert.ok(sortFix && unusedFix)
    assert.ok(sortFix.range[0] <= unusedFix.range[0] && sortFix.range[1] >= unusedFix.range[1])

    assert.deepEqual(await applyTypedLintFixes(results, program), [file])
    const written = await readFile(file, 'utf8')
    assert.equal(written[0], '\uFEFF')
    assert.equal(written.slice(1).includes('\uFEFF'), false)
    assert.equal(written.slice(1).match(/^import /gmu)?.length, 3)
    assert.equal(written.match(/from '\.\/a'/gu)?.length, 1)
    assert.equal(written.match(/from '\.\/z'/gu)?.length, 1)
    assert.equal(written.match(/from '\.\/unused'/gu)?.length, 1)

    const freshProgram = ts.createProgram([file], options)
    const fresh = await lint(freshProgram)
    assert.deepEqual(fresh[0]!.messages.map((message) => message.ruleId), [
      'unused-imports/no-unused-imports',
    ])
    await assert.rejects(applyTypedLintFixes(results, program), /Lint input changed/u)
    assert.equal(await readFile(file, 'utf8'), written)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
