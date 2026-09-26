/** Each external-engine turn gets the complete current mode state, including ordinary work. */
export function buildModeInstructions(executionModes: readonly string[]): string {
  const modes = ['plan', 'goal'].filter((mode) => executionModes.includes(mode))
  return [
    `Current Workbench execution modes: ${modes.length > 0 ? modes.join(', ') : 'standard'}.`,
    'Work directly in the current project. Keep changes focused and report the result concisely.',
    ...(modes.includes('goal')
      ? ['VelarOS goal mode is active: keep advancing the current objective until it is achieved.']
      : []),
    ...(modes.includes('plan')
      ? ['VelarOS plan mode is active: maintain and update a concise plan while continuing implementation. Plan mode is writable.']
      : []),
  ].join('\n')
}
