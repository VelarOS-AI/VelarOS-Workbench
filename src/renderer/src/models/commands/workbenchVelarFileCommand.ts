import type { PackageManagerCommand } from './workbenchPackageScriptCommand'
import { quoteWorkbenchShellPath } from './workbenchPackageScriptCommand'

export function isWorkbenchVelarFilePath(path: Nullable<string>): boolean {
  return !!path?.toLowerCase().endsWith('.vel')
}

export function getWorkbenchVelarExecutable(packageManager: PackageManagerCommand): string {
  switch (packageManager) {
    case 'bun':
      return 'bunx --no-install velar'
    case 'pnpm':
      return 'pnpm exec velar'
    case 'yarn':
      return 'yarn exec velar'
    case 'npm':
      return 'npx --no-install velar'
  }
}

export function buildWorkbenchVelarRunCommand(
  path: string,
  packageManager: PackageManagerCommand
): string {
  return `${getWorkbenchVelarExecutable(packageManager)} run ${quoteWorkbenchShellPath(path)}`
}

export function buildWorkbenchVelarBuildCommand(
  path: string,
  packageManager: PackageManagerCommand
): string {
  return `${getWorkbenchVelarExecutable(packageManager)} build ${quoteWorkbenchShellPath(path)}`
}
