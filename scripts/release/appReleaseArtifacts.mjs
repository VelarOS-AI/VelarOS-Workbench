import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const platformNames = new Set(['macos', 'windows', 'linux'])

export async function readWorkbenchAppVersion(repoRoot) {
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const appPackage = JSON.parse(
    await readFile(path.join(repoRoot, 'apps/workbench/package.json'), 'utf8')
  )
  if (rootPackage.version !== appPackage.version) {
    throw new Error(
      `Root version ${rootPackage.version} does not match app version ${appPackage.version}.`
    )
  }
  return appPackage.version
}

export async function validateReleaseTag(repoRoot, tag) {
  const version = await readWorkbenchAppVersion(repoRoot)
  const expected = `v${version}`
  if (tag !== expected) {
    throw new Error(`Release tag ${tag || '<empty>'} must equal app version tag ${expected}.`)
  }
  return version
}

export async function stageReleaseArtifacts({
  releaseDir,
  stageDir,
  platform,
}) {
  if (!platformNames.has(platform)) throw new Error(`Unknown release platform: ${platform}`)
  const entries = await readdir(releaseDir, { withFileTypes: true })
  const artifacts = entries
    .filter((entry) => entry.isFile() && isReleaseArtifact(entry.name, platform))
    .map((entry) => entry.name)
    .sort()
  if (artifacts.length === 0) {
    throw new Error(`No ${platform} release artifacts found in ${releaseDir}.`)
  }

  await mkdir(stageDir, { recursive: true })
  const checksumLines = []
  for (const name of artifacts) {
    const source = path.join(releaseDir, name)
    const target = path.join(stageDir, name)
    await copyFile(source, target)
    const bytes = await readFile(source)
    checksumLines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
  }
  const checksumName = `SHA256SUMS-${platform}.txt`
  await writeFile(
    path.join(stageDir, checksumName),
    `${checksumLines.join('\n')}\n`,
    'utf8'
  )
  return [...artifacts, checksumName]
}

function isReleaseArtifact(name, platform) {
  if (name.startsWith('SHA256SUMS-')) return false
  if (/^latest(?:-mac|-linux)?(?:-[^.]+)?\.ya?ml$/i.test(name)) return true
  if (!name.startsWith('VelarOS-Workbench-')) return false
  switch (platform) {
    case 'macos':
      return /\.(?:dmg|zip|blockmap)$/i.test(name)
    case 'windows':
      return /\.(?:exe|msi|blockmap)$/i.test(name)
    case 'linux':
      return /\.(?:AppImage|deb|rpm|snap|blockmap)$/i.test(name)
    default:
      return false
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const repoRoot = process.cwd()
  if (command === 'validate-tag') {
    await validateReleaseTag(repoRoot, args[0] ?? process.env.RELEASE_TAG ?? '')
    return
  }
  if (command === 'stage') {
    const [platform, releaseDir = 'release', stageDir = `release-stage/${platform}`] = args
    const staged = await stageReleaseArtifacts({
      releaseDir: path.resolve(repoRoot, releaseDir),
      stageDir: path.resolve(repoRoot, stageDir),
      platform,
    })
    console.log(`Staged ${staged.length} ${platform} release files.`)
    return
  }
  throw new Error('Usage: appReleaseArtifacts.mjs validate-tag <tag> | stage <platform>')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
