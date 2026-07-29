import { access, lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const projectsRoot = path.dirname(root)
const scope = '@velaros-ai/'
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const exists = async (file) => access(file).then(() => true, () => false)
const entryExists = async (file) => lstat(file).then(() => true, () => false)
const packageManifests = []
for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
  const manifestPath = path.join(root, 'packages', entry.name, 'package.json')
  if (entry.isDirectory() && await exists(manifestPath)) packageManifests.push({ directory: path.dirname(manifestPath), manifest: await readJson(manifestPath) })
}
const appManifests = []
for (const entry of await readdir(path.join(root, 'apps'), { withFileTypes: true })) {
  const manifestPath = path.join(root, 'apps', entry.name, 'package.json')
  if (entry.isDirectory() && await exists(manifestPath)) appManifests.push({ directory: path.dirname(manifestPath), manifest: await readJson(manifestPath) })
}
const ownNames = new Set(packageManifests.map(({ manifest }) => manifest.name))
const manifests = [await readJson(path.join(root, 'package.json')), ...packageManifests.map(({ manifest }) => manifest), ...appManifests.map(({ manifest }) => manifest)]
const externalNames = new Set()
for (const manifest of manifests) for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[field] ?? {})) if (name.startsWith(scope) && !ownNames.has(name) && spec !== 'workspace:*') externalNames.add(name)
}
// 理想架构迁移 P6（2026-07-29）：VelarOS-Platform 是 host 无关包的唯一权威单仓。
// 同名包同时存在于 Platform 与旧独立仓（Core/Agent/Kernel/Model/UI/Capabilities/…）时一律优先
// Platform；旧仓仅作过渡回落，归档批完成后连同本常量一并删除。
const canonicalRepositoryName = 'VelarOS-Platform'
const available = new Map()
const rememberAvailable = (manifest, directory, repositoryName) => {
  const name = manifest.name
  if (!name?.startsWith(scope)) return
  const candidate = {
    directory,
    canonical: repositoryName === canonicalRepositoryName,
    version: manifest.version ?? '0.0.0',
  }
  const current = available.get(name)
  if (!current) {
    available.set(name, candidate)
    return
  }
  // Platform 一票压过旧仓；旧仓之间才比版本号。
  if (current.canonical !== candidate.canonical) {
    if (candidate.canonical) available.set(name, candidate)
    return
  }
  if (current.version.localeCompare(candidate.version, undefined, { numeric: true }) < 0) {
    available.set(name, candidate)
  }
}
const resolveAvailableDirectory = (name) => available.get(name)?.directory
for (const repo of await readdir(projectsRoot, { withFileTypes: true })) {
  if (!repo.isDirectory() || !repo.name.startsWith('VelarOS-')) continue
  const siblingRootManifest = path.join(projectsRoot, repo.name, 'package.json')
  if (await exists(siblingRootManifest)) {
    const manifest = await readJson(siblingRootManifest)
    rememberAvailable(manifest, path.dirname(siblingRootManifest), repo.name)
  }
  const siblingPackages = path.join(projectsRoot, repo.name, 'packages')
  if (!await exists(siblingPackages)) continue
  for (const entry of await readdir(siblingPackages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDir = path.join(siblingPackages, entry.name)
    const manifestPath = path.join(packageDir, 'package.json')
    if (await exists(manifestPath)) {
      rememberAvailable(await readJson(manifestPath), packageDir, repo.name)
      continue
    }
    // packages/<分组>/<包> 二级布局（Platform 的 packages/capabilities/* 即此形态）。
    for (const nested of await readdir(packageDir, { withFileTypes: true })) {
      const nestedManifest = path.join(packageDir, nested.name, 'package.json')
      if (!nested.isDirectory() || !await exists(nestedManifest)) continue
      rememberAvailable(await readJson(nestedManifest), path.dirname(nestedManifest), repo.name)
    }
  }
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
for (const item of packageManifests) {
  run(['link'], item.directory)
  await linkIntoProject(root, item.manifest.name, item.directory)
}
for (const name of externalNames) {
  const directory = resolveAvailableDirectory(name)
  if (!directory) throw new Error(`No sibling checkout provides ${name}`)
  run(['link'], directory)
  await linkIntoProject(root, name, directory)
}
for (const item of packageManifests) {
  const dependencies = { ...item.manifest.dependencies, ...item.manifest.optionalDependencies }
  for (const name of Object.keys(dependencies)) {
    const directory = resolveAvailableDirectory(name)
    if (directory) await linkIntoProject(item.directory, name, directory)
  }
}
for (const item of appManifests) {
  const dependencies = { ...item.manifest.dependencies, ...item.manifest.optionalDependencies }
  for (const name of Object.keys(dependencies)) {
    const directory = resolveAvailableDirectory(name)
    if (directory) await linkIntoProject(item.directory, name, directory)
  }
}
console.log(`Registered ${ownNames.size} local package(s); linked ${externalNames.size} external package(s).`)
