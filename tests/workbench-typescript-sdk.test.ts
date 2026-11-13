import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { test } from 'bun:test'

import { resolveLanguageTypeScriptSdk } from '../src/main/workspace/language/TypeScriptSdk'

test('external language servers use the packaged SDK with both code and standard declarations', () => {
  const resources = mkdtempSync(join(tmpdir(), 'wb-lsp-sdk-'))
  const sdk = join(resources, 'typescript', 'lib')
  try {
    mkdirSync(sdk, { recursive: true })
    const developmentSdk = dirname(
      createRequire(import.meta.url).resolve('typescript/lib/typescript.js')
    )
    assert.equal(resolveLanguageTypeScriptSdk(resources), developmentSdk)
    writeFileSync(join(sdk, 'typescript.js'), '// app-owned TypeScript runtime')
    assert.equal(resolveLanguageTypeScriptSdk(resources), developmentSdk)
    writeFileSync(join(sdk, 'lib.es5.d.ts'), 'interface Array<T> { length: number }')
    assert.equal(resolveLanguageTypeScriptSdk(resources), developmentSdk)
    writeFileSync(
      join(sdk, '..', 'package.json'),
      JSON.stringify({ name: 'typescript', version: '5.9.3' })
    )
    assert.equal(resolveLanguageTypeScriptSdk(resources), sdk)
  } finally {
    rmSync(resources, { recursive: true, force: true })
  }
})
