import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)

export function languageWorkerResourcesPath(): Nullable<string> {
  const data = workerData as { resourcesPath?: unknown } | null | undefined
  return typeof data?.resourcesPath === 'string'
    ? data.resourcesPath
    : (process.resourcesPath ?? null)
}

/** External servers need executable TypeScript and its declarations in the same SDK. */
export function resolveLanguageTypeScriptSdk(
  resourcesPath: Nullable<string> = languageWorkerResourcesPath()
): string {
  if (resourcesPath) {
    const directory = join(resourcesPath, 'typescript', 'lib')
    if (
      existsSync(join(directory, 'typescript.js')) &&
      existsSync(join(directory, 'lib.es5.d.ts')) &&
      existsSync(join(directory, '..', 'package.json'))
    )
      return directory
  }
  return dirname(require.resolve('typescript/lib/typescript.js'))
}
