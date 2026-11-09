import type { Extension } from '@codemirror/state'

import type { WorkbenchRunSessionLaunchOptions } from '../commands/workbenchCommandLines'
import type { PackageManagerCommand } from '../commands/workbenchPackageScriptCommand'
import {
  buildWorkbenchVelarRunCommand,
  isWorkbenchVelarFilePath,
} from '../commands/workbenchVelarFileCommand'

import {
  createWorkbenchRunGutterExtension,
  type WorkbenchRunGutterAction,
} from './workbenchRunGutter'

interface WorkbenchVelarMainRunGutterOptions {
  content: string
  packageManager: PackageManagerCommand
  path: Nullable<string>
}

interface WorkbenchVelarMainRunExtensionOptions extends WorkbenchVelarMainRunGutterOptions {
  disabled?: boolean
  onRunMain: (command: string, launch?: WorkbenchRunSessionLaunchOptions) => void
}

const VELAR_MAIN_DECLARATION_PATTERN = /^\s*@main\s*:/u

export function shouldShowWorkbenchVelarMainRunGutter(path: Nullable<string>): boolean {
  return isWorkbenchVelarFilePath(path)
}

export function buildWorkbenchVelarMainRunActions({
  content,
  packageManager,
  path,
}: WorkbenchVelarMainRunGutterOptions): WorkbenchRunGutterAction[] {
  if (!path || !isWorkbenchVelarFilePath(path)) return []

  const command = buildWorkbenchVelarRunCommand(path, packageManager)
  return content.split(/\r?\n/u).flatMap((line, index) =>
    VELAR_MAIN_DECLARATION_PATTERN.test(line)
      ? [{ ...command, label: '@main', line: index + 1 }]
      : []
  )
}

export function createWorkbenchVelarMainRunGutterExtension({
  content,
  disabled = false,
  onRunMain,
  packageManager,
  path,
}: WorkbenchVelarMainRunExtensionOptions): Extension {
  return createWorkbenchRunGutterExtension({
    actions: buildWorkbenchVelarMainRunActions({ content, packageManager, path }),
    disabled,
    onRun: onRunMain,
  })
}
