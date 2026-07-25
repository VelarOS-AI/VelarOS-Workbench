import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LanguageGrammarInstaller } from './LanguageGrammarInstaller'

let assertions = 0
function assert(condition: unknown, message: string): asserts condition {
  assertions += 1
  if (!condition) throw new Error(message)
}

const root = await mkdtemp(join(tmpdir(), 'velaros-workbench-grammar-'))
const artifacts = join(root, 'artifacts')
const installed = join(root, 'installed')
await mkdir(artifacts)

const code = 'export const create = () => [];\n'
const file = 'grammar-java-1.2.3.js'
const sha256 = createHash('sha256').update(code).digest('hex')
await writeFile(join(artifacts, file), code)
await writeFile(
  join(artifacts, 'grammars-manifest.json'),
  JSON.stringify({
    runtimeGlobal: '__VELAROS_CM__',
    grammars: {
      java: { version: '1.2.3', file, sha256, size: Buffer.byteLength(code) },
    },
  })
)

let now = 100
const installer = new LanguageGrammarInstaller({
  installRoot: () => installed,
  artifactBase: () => pathToFileURL(`${artifacts}/`).href,
  now: () => now,
})
let changes = 0
installer.subscribe(() => {
  changes += 1
})

try {
  const before = await installer.listCatalog()
  assert(before.runtimeGlobal === '__VELAROS_CM__', 'runtime global must match renderer')
  assert(before.grammars.some((grammar) => grammar.id === 'java'), 'catalog must list Java')
  assert(!before.grammars.find((grammar) => grammar.id === 'java')?.installed, 'Java starts absent')

  await installer.install('java')
  const after = await installer.listCatalog()
  const java = after.grammars.find((grammar) => grammar.id === 'java')
  assert(java?.installed, 'verified grammar must be installed')
  assert(java.version === '1.2.3', 'installed version must come from manifest')
  assert(!java.install, 'successful install must clear transient state')
  assert((await readFile(join(installed, 'java', 'index.js'), 'utf8')) === code, 'entry is exact')
  assert(changes >= 3, 'download, verify and completion must notify')

  await rename(join(installed, 'java'), join(installed, '.backup-java'))
  await mkdir(join(installed, '.staging-java-crash'))
  const recovered = (await installer.listCatalog()).grammars.find(
    (grammar) => grammar.id === 'java'
  )
  assert(recovered?.installed, 'catalog must recover a crash between backup and replacement')
  assert(
    await stat(join(installed, '.staging-java-crash')).then(
      () => false,
      () => true
    ),
    'catalog recovery must remove abandoned staging directories'
  )

  now = 200
  await writeFile(
    join(artifacts, 'grammars-manifest.json'),
    JSON.stringify({
      runtimeGlobal: '__VELAROS_CM__',
      grammars: {
        java: {
          version: '2.0.0',
          file,
          sha256: '0'.repeat(64),
          size: Buffer.byteLength(code),
        },
      },
    })
  )
  await installer.install('java')
  const failed = (await installer.listCatalog()).grammars.find((grammar) => grammar.id === 'java')
  assert(failed?.installed, 'failed upgrade must preserve previous verified grammar')
  assert(failed.version === '1.2.3', 'failed upgrade must preserve previous metadata')
  assert(failed.install?.phase === 'failed', 'failed upgrade must expose failure state')
  assert(
    (await readFile(join(installed, 'java', 'index.js'), 'utf8')) === code,
    'failed upgrade must preserve previous entry'
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.info(`workbench language grammar probe passed (${assertions} assertions)`)
