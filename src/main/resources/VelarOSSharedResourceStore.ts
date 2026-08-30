import { homedir } from 'node:os'
import { join } from 'node:path'

interface VelarOSSharedResourceStoreOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

/** `@velaros-ai/system/shared-resources` 磁盘 ABI 的发布兼容投影。 */
function resolveVelarOSSharedDataRoot(
  options: VelarOSSharedResourceStoreOptions = {}
): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const override = env['VELAROS_SHARED_DATA_ROOT']?.trim()
  if (override) return override
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']?.trim()
    const appData = env['APPDATA']?.trim()
    return join(localAppData || appData || join(homeDirectory, 'AppData', 'Local'), 'VelarOS')
  }
  if (platform === 'darwin') return join(homeDirectory, 'Library', 'Application Support', 'VelarOS')
  return join(env['XDG_DATA_HOME']?.trim() || join(homeDirectory, '.local', 'share'), 'VelarOS')
}

function resolveVelarOSSharedResourcesRoot(
  options: VelarOSSharedResourceStoreOptions = {}
): string {
  return join(resolveVelarOSSharedDataRoot(options), 'shared', 'resources')
}

/** `@velaros-ai/system/shared-resources` 账号磁盘 ABI 的发布兼容投影。 */
function resolveVelarOSSharedAccountRoot(
  options: VelarOSSharedResourceStoreOptions = {}
): string {
  return join(resolveVelarOSSharedDataRoot(options), 'shared', 'account', 'v1')
}

export {
  resolveVelarOSSharedAccountRoot,
  resolveVelarOSSharedDataRoot,
  resolveVelarOSSharedResourcesRoot,
  type VelarOSSharedResourceStoreOptions,
}
