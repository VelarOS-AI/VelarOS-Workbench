import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dryRun = process.argv.includes('--dry-run')
const registry = 'https://npm.pkg.github.com'
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const rootManifest = await readJson(path.join(root, 'package.json'))
const directories = (await readdir(path.join(root, 'packages'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, 'packages', entry.name))
const packages = []
for (const directory of directories) {
  const manifest = await readJson(path.join(directory, 'package.json'))
  if (manifest.private === true) continue
  if (!manifest.name?.startsWith('@velaros-ai/')) throw new Error(`Invalid package name: ${manifest.name}`)
  if (manifest.publishConfig?.registry !== registry) throw new Error(`${manifest.name} must publish to ${registry}`)
  packages.push({ directory, manifest })
}
const byName = new Map(packages.map((item) => [item.manifest.name, item]))
const ordered = []
const visiting = new Set()
const visited = new Set()
const visit = (item) => {
  if (visited.has(item.manifest.name)) return
  if (visiting.has(item.manifest.name)) throw new Error(`Dependency cycle at ${item.manifest.name}`)
  visiting.add(item.manifest.name)
  const dependencies = { ...item.manifest.dependencies, ...item.manifest.optionalDependencies, ...item.manifest.peerDependencies }
  for (const name of Object.keys(dependencies)) if (byName.has(name)) visit(byName.get(name))
  visiting.delete(item.manifest.name)
  visited.add(item.manifest.name)
  ordered.push(item)
}
for (const item of packages) visit(item)
if (!dryRun && !process.env.NODE_AUTH_TOKEN) throw new Error('NODE_AUTH_TOKEN is required to publish packages')
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
}
run('bun', ['run', rootManifest.scripts?.['build:package'] ? 'build:package' : 'build'], root)
for (const item of ordered) {
  const args = ['publish', '--cwd', item.directory, '--registry', registry, '--access', 'restricted', '--tolerate-republish', '--ignore-scripts']
  if (dryRun) args.push('--dry-run')
  run('bun', args, root)
}
