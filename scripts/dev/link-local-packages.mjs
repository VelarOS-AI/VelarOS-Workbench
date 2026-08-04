import { access, lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const projectsRoot = path.dirname(root)
const platformPackagesRoot = path.join(projectsRoot, 'VelarOS-Platform', 'packages')
const scope = '@velaros-ai/'
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const exists = async (file) => access(file).then(() => true, () => false)
const entryExists = async (file) => lstat(file).then(() => true, () => false)
const manifest = await readJson(path.join(root, 'package.json'))
const externalNames = new Set()
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
    if (name.startsWith(scope) && spec !== 'workspace:*') externalNames.add(name)
  }
}
const available = new Map()
const rememberAvailable = (manifest, directory) => {
  const name = manifest.name
  if (!name?.startsWith(scope)) return
  if (available.has(name)) {
    throw new Error(`Package ${name} is declared more than once in VelarOS-Platform`)
  }
  available.set(name, directory)
}
if (!await exists(platformPackagesRoot)) {
  throw new Error('VelarOS-Platform/packages is required for local linking')
}
for (const entry of await readdir(platformPackagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const packageDir = path.join(platformPackagesRoot, entry.name)
  const manifestPath = path.join(packageDir, 'package.json')
  if (!await exists(manifestPath)) continue
  rememberAvailable(await readJson(manifestPath), packageDir)
}
const run = (args, cwd) => {
  const result = spawnSync('bun', args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`bun ${args.join(' ')} failed with exit code ${result.status}`)
}
const linkIntoProject = async (base, name, directory) => {
  const target = path.join(base, 'node_modules', ...name.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  if (await entryExists(target)) {
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) {
      const current = path.resolve(path.dirname(target), await readlink(target))
      if (current === directory) return
    }
    await rm(target, { recursive: true, force: true })
  }
  await symlink(directory, target, 'dir')
}
for (const name of externalNames) {
  const directory = available.get(name)
  if (!directory) throw new Error(`No sibling checkout provides ${name}`)
  run(['link'], directory)
  await linkIntoProject(root, name, directory)
}
console.log(`Linked ${externalNames.size} external package(s) into the Workbench monolith.`)
