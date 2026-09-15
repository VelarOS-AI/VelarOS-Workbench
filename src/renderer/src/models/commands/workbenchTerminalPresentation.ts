export function buildWorkbenchTerminalSessionTitle(
  sessionIndex: number,
  labels: { local: string; localIndexed: (index: number) => string }
): string {
  if (sessionIndex <= 0) return labels.local

  return labels.localIndexed(sessionIndex + 1)
}
