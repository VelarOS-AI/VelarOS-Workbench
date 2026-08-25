import type { Extension } from '@codemirror/state'

import type { PackageManagerCommand } from '../commands/workbenchPackageScriptCommand'
import { quoteWorkbenchShellPath } from '../commands/workbenchPackageScriptCommand'
import { getWorkbenchVelarExecutable } from '../commands/workbenchVelarFileCommand'
import { isWorkbenchTestFilePath } from '../files/workbenchTestFile'

import {
  createWorkbenchRunGutterExtension,
  type WorkbenchRunGutterAction,
} from './workbenchRunGutter'

interface WorkbenchVelarTestRunGutterOptions {
  content: string
  packageManager: PackageManagerCommand
  path: Nullable<string>
}

interface WorkbenchVelarTestRunExtensionOptions extends WorkbenchVelarTestRunGutterOptions {
  disabled?: boolean
  onRunTest: (command: string) => void
}

const VELAR_TEST_DECLARATION_PATTERN = /^\s*test\s+("(?:[^"\\]|\\.)*")\s*:/u

export function shouldShowWorkbenchVelarTestRunGutter(path: Nullable<string>): boolean {
  return !!path?.toLowerCase().endsWith('.test.vel')
}

export function buildWorkbenchVelarTestRunCommand(
  path: string,
  packageManager: PackageManagerCommand
): string {
  const browserFlag = path.toLowerCase().endsWith('.browser.test.vel') ? ' --browser' : ''
  return `${getWorkbenchVelarExecutable(packageManager)} test ${quoteWorkbenchShellPath(path)}${browserFlag}`
}

export function buildWorkbenchVelarTestRunActions({
  content,
  packageManager,
  path,
}: WorkbenchVelarTestRunGutterOptions): WorkbenchRunGutterAction[] {
  if (!path || !shouldShowWorkbenchVelarTestRunGutter(path) || !isWorkbenchTestFilePath(path))
    return []

  const command = buildWorkbenchVelarTestRunCommand(path, packageManager)
  const actions: WorkbenchRunGutterAction[] = []
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const declaration = VELAR_TEST_DECLARATION_PATTERN.exec(line)
    if (!declaration) continue

    let label = declaration[1]!
    try {
      label = JSON.parse(label) as string
    } catch {
      // Editing may temporarily leave an incomplete escape; keep the literal label usable.
    }
    actions.push({ command, label, line: index + 1 })
  }
  return actions
}

export function createWorkbenchVelarTestRunGutterExtension({
  content,
  disabled = false,
  onRunTest,
  packageManager,
  path,
}: WorkbenchVelarTestRunExtensionOptions): Extension {
  return createWorkbenchRunGutterExtension({
    actions: buildWorkbenchVelarTestRunActions({ content, packageManager, path }),
    disabled,
    onRun: onRunTest,
  })
}
