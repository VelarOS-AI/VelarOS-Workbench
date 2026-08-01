import type { WorkbenchTerminalSessionView } from './workbenchCommandLines'

export function formatWorkbenchTerminalPrompt(session: WorkbenchTerminalSessionView): string {
  const folder = session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd
  const shellName = session.shell.split('/').at(-1) ?? 'zsh'
  const marker = shellName.includes('fish') ? '>' : shellName === 'bash' ? '$' : '%'

  return `${folder} ${marker} `
}

export function buildWorkbenchTerminalSessionTitle(
  sessionIndex: number,
  labels: { local: string; localIndexed: (index: number) => string }
): string {
  if (sessionIndex <= 0) return labels.local

  return labels.localIndexed(sessionIndex + 1)
}
