export function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return env[name]
  // Apply Windows casing rules to the case-sensitive Node worker environment.
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}
