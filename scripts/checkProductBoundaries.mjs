import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoots = [
  resolve(rootDir, 'apps/workbench/src'),
  resolve(rootDir, 'packages/workbench/src'),
]
const sourceExtensions = new Set(['.ts', '.tsx'])
const forbiddenSpecifiers = [
  /^apps\/desktop(?:\/|$)/,
  /^@(?:components|hooks|runtime|shared)\//,
  /^@\//,
  /VelarOS-Desktop/,
]
const importSpecifierPattern =
  /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)))
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path)
  }

  return files
}

const failures = []
for (const sourceRoot of sourceRoots) {
  for (const path of await collectSourceFiles(sourceRoot)) {
    const source = await readFile(path, 'utf8')
    for (const match of source.matchAll(importSpecifierPattern)) {
      const specifier = match[1]
      if (forbiddenSpecifiers.some((pattern) => pattern.test(specifier))) {
        failures.push(`${relative(rootDir, path)} imports Desktop-private "${specifier}"`)
      }
    }
  }
}

const packageManifestPath = resolve(rootDir, 'packages/workbench/package.json')
const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'))
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, version] of Object.entries(packageManifest[field] ?? {})) {
    if (/^(?:file:|link:|workspace:)/u.test(version)) {
      failures.push(`packages/workbench/package.json ${field}.${name} is not publishable: ${version}`)
    }
  }
}

if (failures.length > 0) {
  console.error('Workbench product boundary check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Workbench product boundary check passed.')
}
