import type { WorkbenchPackageManagerTarget } from '@shared/contracts/workbench'

import { buildWorkbenchProcessRunCommand, type WorkbenchRunCommand } from './workbenchCommandLines'
import type { PackageManagerCommand } from './workbenchPackageScriptCommand'

export function isWorkbenchVelarFilePath(path: Nullable<string>): boolean {
  return !!path?.toLowerCase().endsWith('.vel')
}

export function getWorkbenchVelarExecutable(
  packageManager: PackageManagerCommand
): WorkbenchPackageManagerTarget {
  switch (packageManager) {
    case 'bun':
      return { kind: 'package-manager', program: 'bunx', argv: ['--no-install', 'velar'] }
    case 'pnpm':
      return { kind: 'package-manager', program: 'pnpm', argv: ['exec', 'velar'] }
    case 'yarn':
      return { kind: 'package-manager', program: 'yarn', argv: ['exec', 'velar'] }
    case 'npm':
      return { kind: 'package-manager', program: 'npx', argv: ['--no-install', 'velar'] }
  }
}

export function buildWorkbenchVelarRunCommand(
  path: string,
  packageManager: PackageManagerCommand
): WorkbenchRunCommand {
  const process = getWorkbenchVelarExecutable(packageManager)
  return buildWorkbenchProcessRunCommand({ ...process, argv: [...process.argv, 'run', path] })
}

export function buildWorkbenchVelarBuildCommand(
  path: string,
  packageManager: PackageManagerCommand
): WorkbenchRunCommand {
  const process = getWorkbenchVelarExecutable(packageManager)
  return buildWorkbenchProcessRunCommand({ ...process, argv: [...process.argv, 'build', path] })
}
