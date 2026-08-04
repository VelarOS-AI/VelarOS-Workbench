import { currentSystemPlatform as systemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'

export function resolveWorkbenchChatWorkspacePath(
  path: string,
  projectRoot: string
): Nullable<string> {
  const trimmedPath = path.trim()
  if (!trimmedPath) return null

  if (!systemPlatformCompatibility.isAbsolutePathText(trimmedPath))
    return systemPlatformCompatibility.stripLeadingPathTextSeparators(
      trimmedPath.replace(/^\.\//, '')
    )

  const normalizedPath = systemPlatformCompatibility.normalizePathTextForComparison(trimmedPath)
  const normalizedRoot = systemPlatformCompatibility.normalizePathTextForComparison(projectRoot)

  if (normalizedPath === normalizedRoot) return '.'
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return null

  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '')
}
