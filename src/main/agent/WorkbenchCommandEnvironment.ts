import {
  currentSystemPlatform,
  getSystemShellKind,
} from '@velaros-ai/system/platform-compatibility'

/** Uses the same shell selection as CommandHelper, without executing a probe command. */
export function workbenchCommandEnvironment(): string {
  const shellPath = currentSystemPlatform.getPreferredShellPath(process.env)
  return `Host command environment: ${JSON.stringify({
    platform: currentSystemPlatform.getPlatform(),
    shell: {
      kind: getSystemShellKind(shellPath),
      name: currentSystemPlatform.getPathTextBaseName(shellPath),
    },
  })}`
}
