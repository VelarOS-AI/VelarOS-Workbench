import { homedir } from 'node:os'
import { join } from 'node:path'

interface VelarOSSharedResourceStoreOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

/**
 * `@velaros-ai/system/shared-resources` 磁盘 ABI v1 的产品兼容投影。
 *
 * 当前发布锁仍指向尚未导出该子路径的 System 版本；下一次 Platform 依赖升级前，Workbench
 * 以这层纯路径适配保持可独立构建。配置、项目索引和缓存仍留在自己的 userData。
 */
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

  if (platform === 'darwin')
    return join(homeDirectory, 'Library', 'Application Support', 'VelarOS')

  const xdgDataHome = env['XDG_DATA_HOME']?.trim()
  return join(xdgDataHome || join(homeDirectory, '.local', 'share'), 'VelarOS')
}

/** 组织级资源根：<VelarOS shared data>/shared/resources/<resource-id>/... */
function resolveVelarOSSharedResourcesRoot(
  options: VelarOSSharedResourceStoreOptions = {}
): string {
  return join(resolveVelarOSSharedDataRoot(options), 'shared', 'resources')
}

export {
  resolveVelarOSSharedDataRoot,
  resolveVelarOSSharedResourcesRoot,
  type VelarOSSharedResourceStoreOptions,
}
