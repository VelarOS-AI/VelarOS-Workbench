import { access, lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const projectsRoot = path.dirname(root)
const scope = '@velaros-ai/'
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const exists = async (file) => access(file).then(() => true, () => false)
const packageManifests = []
for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
  const manifestPath = path.join(root, 'packages', entry.name, 'package.json')
  if (entry.isDirectory() && await exists(manifestPath)) packageManifests.push({ directory: path.dirname(manifestPath), manifest: await readJson(manifestPath) })
}
const ownNames = new Set(packageManifests.map(({ manifest }) => manifest.name))
const manifests = [await readJson(path.join(root, 'package.json')), ...packageManifests.map(({ manifest }) => manifest)]
const externalNames = new Set()
for (const manifest of manifests) for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[field] ?? {})) if (name.startsWith(scope) && !ownNames.has(name) && spec !== 'workspace:*') externalNames.add(name)
}
const available = new Map()
for (const repo of await readdir(projectsRoot, { withFileTypes: true })) {
  if (!repo.isDirectory() || !repo.name.startsWith('VelarOS-')) continue
  const siblingPackages = path.join(projectsRoot, repo.name, 'packages')
  if (!await exists(siblingPackages)) continue
  for (const entry of await readdir(siblingPackages, { withFileTypes: true })) {
    const manifestPath = path.join(siblingPackages, entry.name, 'package.json')
    if (!entry.isDirectory() || !await exists(manifestPath)) continue
    const manifest = await readJson(manifestPath)
    if (manifest.name?.startsWith(scope)) available.set(manifest.name, path.dirname(manifestPath))
  }
}
const run = (args, cwd) => {
  const result = spawnSync('bun', args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`bun ${args.join(' ')} failed with exit code ${result.status}`)
}
const linkIntoProject = async (base, name, directory) => {
  const target = path.join(base, 'node_modules', ...name.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  if (await exists(target)) {
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) {
      const current = path.resolve(path.dirname(target), await readlink(target))
      if (current === directory) return
    }
    await rm(target, { recursive: true, force: true })
  }
  await symlink(directory, target, 'dir')
}
for (const item of packageManifests) {
  run(['link'], item.directory)
  await linkIntoProject(root, item.manifest.name, item.directory)
}
for (const name of externalNames) {
  const directory = available.get(name)
  if (!directory) throw new Error(`No sibling checkout provides ${name}`)
  run(['link'], directory)
  await linkIntoProject(root, name, directory)
}
for (const item of packageManifests) {
  const dependencies = { ...item.manifest.dependencies, ...item.manifest.optionalDependencies }
  for (const name of Object.keys(dependencies)) {
    const directory = available.get(name)
    if (directory) await linkIntoProject(item.directory, name, directory)
  }
}
console.log(`Registered ${ownNames.size} local package(s); linked ${externalNames.size} external package(s).`)
