import type { WorkbenchCommandHistoryItem } from './workbenchCommandHistory'
import { type WorkbenchRunCommand, workbenchRunCommandKey } from './workbenchCommandLines'
import type { WorkbenchCommandSuggestion } from './workbenchCommandSuggestions'

export type WorkbenchRunConfigurationKind = 'build' | 'check' | 'dev' | 'lint' | 'test' | 'task'

export interface WorkbenchRunConfiguration extends WorkbenchRunCommand {
  id: string
  label: string
  source: string
  kind: WorkbenchRunConfigurationKind
}

const KIND_PRIORITY: WorkbenchRunConfigurationKind[] = [
  'check',
  'test',
  'lint',
  'build',
  'dev',
  'task',
]

function inferRunConfigurationKind(label: string, command: string): WorkbenchRunConfigurationKind {
  const text = `${label} ${command}`.toLowerCase()

  if (/\b(typecheck|check|verify|validate)\b/.test(text)) return 'check'

  if (/\b(test|spec)\b/.test(text)) return 'test'

  if (/\b(lint|eslint)\b/.test(text)) return 'lint'

  if (/\b(build|compile)\b/.test(text)) return 'build'

  if (/\b(dev|serve|start)\b/.test(text)) return 'dev'

  return 'task'
}

function compareRunConfigurations(
  left: WorkbenchRunConfiguration,
  right: WorkbenchRunConfiguration
): number {
  const leftPriority = KIND_PRIORITY.indexOf(left.kind)
  const rightPriority = KIND_PRIORITY.indexOf(right.kind)
  if (leftPriority !== rightPriority) return leftPriority - rightPriority

  return left.label.localeCompare(right.label)
}

export function buildWorkbenchRunConfigurations({
  suggestions,
  history,
  limit,
}: {
  suggestions: WorkbenchCommandSuggestion[]
  history: WorkbenchCommandHistoryItem[]
  limit?: number
}): WorkbenchRunConfiguration[] {
  const byCommand = new Map<string, WorkbenchRunConfiguration>()

  for (const suggestion of suggestions) {
    const command = suggestion.command.trim()
    const key = workbenchRunCommandKey(command, suggestion.launch)
    if (!command || byCommand.has(key)) {
      continue
    }

    byCommand.set(key, {
      id: `suggestion:${key}`,
      label: suggestion.label,
      command,
      launch: suggestion.launch,
      source: suggestion.source,
      kind: inferRunConfigurationKind(suggestion.label, command),
    })
  }

  for (const item of history) {
    const command = item.command.trim()
    const key = workbenchRunCommandKey(command)
    if (!command || byCommand.has(key)) {
      continue
    }

    byCommand.set(key, {
      id: `history:${key}`,
      label: command,
      command,
      source: 'history',
      kind: inferRunConfigurationKind(command, command),
    })
  }

  const configurations = [...byCommand.values()].sort(compareRunConfigurations)
  return limit === undefined ? configurations : configurations.slice(0, limit)
}
