export type PackageManagerCommand = 'bun' | 'npm' | 'pnpm' | 'yarn'

interface WorkbenchPackageFileLike {
  path: string
  name?: string
}

const PACKAGE_MANAGER_LOCKS: Array<{
  name: string
  packageManager: PackageManagerCommand
}> = [
  { name: 'bun.lock', packageManager: 'bun' },
  { name: 'bun.lockb', packageManager: 'bun' },
  { name: 'pnpm-lock.yaml', packageManager: 'pnpm' },
  { name: 'yarn.lock', packageManager: 'yarn' },
  { name: 'package-lock.json', packageManager: 'npm' },
]

function normalizeWorkbenchPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

export function getWorkbenchPackageJsonDirectory(path: string): string {
  const normalized = normalizeWorkbenchPath(path)
  const slashIndex = normalized.lastIndexOf('/')
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : '.'
}

export function quoteWorkbenchShellPath(path: string): string {
  return /^[\w./:-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

export function formatWorkbenchPackageScriptName(scriptName: string): string {
  return /^[\w:-]+$/.test(scriptName) ? scriptName : JSON.stringify(scriptName)
}

export function buildWorkbenchPackageScriptRunCommand({
  packageJsonPath,
  packageManager,
  scriptName,
}: {
  packageJsonPath: string
  packageManager: PackageManagerCommand
  scriptName: string
}): string {
  const runCommand = `${packageManager} run ${formatWorkbenchPackageScriptName(scriptName)}`
  const directory = getWorkbenchPackageJsonDirectory(packageJsonPath)
  return directory === '.'
    ? runCommand
    : `cd ${quoteWorkbenchShellPath(directory)} && ${runCommand}`
}

export function inferWorkbenchPackageManagerForPackageJsonPath(
  packageJsonPath: string,
  files: readonly WorkbenchPackageFileLike[],
  fallback: PackageManagerCommand
): PackageManagerCommand {
  const directory = getWorkbenchPackageJsonDirectory(packageJsonPath)
  const directoryPrefix = directory === '.' ? '' : `${directory}/`
  const fileNames = new Set(
    files
      .map((file) => normalizeWorkbenchPath(file.path))
      .filter((path) => path.startsWith(directoryPrefix))
      .filter((path) => !path.slice(directoryPrefix.length).includes('/'))
      .map((path) => path.slice(directoryPrefix.length))
  )

  return PACKAGE_MANAGER_LOCKS.find((lock) => fileNames.has(lock.name))?.packageManager ?? fallback
}
