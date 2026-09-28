import { readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import type { Plugin } from 'vite'

/** Linked packages are build inputs, refreshed deliberately when the dev server starts. */
export function linkedPackageWatchIgnore(repoRoot: string): RegExp {
  const scope = join(repoRoot, 'node_modules', '@velaros-ai')
  const roots = readdirSync(scope).flatMap((name) => {
    const path = realpathSync(join(scope, name))
    const fromRepo = relative(repoRoot, path)
    return fromRepo === '..' || fromRepo.startsWith(`..${sep}`) ? [path] : []
  })
  const paths = roots.map((path) => path.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  return paths.length ? new RegExp(`^(?:${paths.join('|')})(?:/|$)`, 'u') : /$a/u
}

/** Preserve electron-vite's opt-in main/preload watcher while constraining its inputs. */
export function isolateLinkedPackageWatcher(ignored: RegExp): Plugin {
  return {
    name: 'workbench:linked-package-watch-boundary',
    config(config) {
      if (!config.build?.watch) return
      return { build: { watch: { exclude: [ignored] } } }
    },
  }
}
