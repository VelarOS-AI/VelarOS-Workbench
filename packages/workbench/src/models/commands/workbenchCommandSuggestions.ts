import { isNonBlankString,isObject, isPlainObject, Log } from '@velaros-ai/core'
import type { WorkbenchDirectoryEntry } from '@velaros-ai/core/types'

import {
  formatWorkbenchPackageScriptName,
  type PackageManagerCommand,
} from './workbenchPackageScriptCommand'

const COMMON_SCRIPT_PRIORITY = ['check', 'typecheck', 'test', 'lint', 'build', 'dev']
const log = Log.tag('workbench-command-suggestions')

export interface WorkbenchCommandSuggestion {
  command: string
  label: string
  source: string
}

export function inferPackageManagerCommand(
  rootEntries: WorkbenchDirectoryEntry[]
): PackageManagerCommand {
  const names = new Set(rootEntries.map((entry) => entry.name))

  if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun'

  if (names.has('pnpm-lock.yaml')) return 'pnpm'

  if (names.has('yarn.lock')) return 'yarn'

  return 'npm'
}

function compareScriptNames(left: string, right: string): number {
  const leftPriority = COMMON_SCRIPT_PRIORITY.indexOf(left)
  const rightPriority = COMMON_SCRIPT_PRIORITY.indexOf(right)

  if (leftPriority !== -1 || rightPriority !== -1)
    return (
      (leftPriority === -1 ? COMMON_SCRIPT_PRIORITY.length : leftPriority) -
      (rightPriority === -1 ? COMMON_SCRIPT_PRIORITY.length : rightPriority)
    )

  return left.localeCompare(right)
}

export function buildPackageScriptCommandSuggestions(
  packageJsonContent: string,
  packageManager: PackageManagerCommand,
  limit = 8
): WorkbenchCommandSuggestion[] {
  let manifest: unknown
  try {
    manifest = JSON.parse(packageJsonContent)
  } catch (error) {
    log.debug('解析 package.json 脚本建议失败，返回空建议', {
      error: String(error),
    })
    return []
  }

  if (!manifest || !isObject(manifest)) return []

  const scripts = (manifest as Record<string, unknown>).scripts
  if (!isPlainObject(scripts)) return []

  return Object.entries(scripts)
    .filter(([, value]) => isNonBlankString(value))
    .map(([name]) => name)
    .sort(compareScriptNames)
    .slice(0, limit)
    .map((name) => ({
      command: `${packageManager} run ${formatWorkbenchPackageScriptName(name)}`,
      label: name,
      source: 'package.json',
    }))
}
