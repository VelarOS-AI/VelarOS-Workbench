import { platformCompatibility } from '@velaros-ai/core/utils/PlatformCompatibilityHelper'

export function resolveWorkbenchChatWorkspacePath(
  path: string,
  projectRoot: string
): Nullable<string> {
  const trimmedPath = path.trim()
  if (!trimmedPath) return null

  if (!platformCompatibility.isAbsolutePathText(trimmedPath))
    return platformCompatibility.stripLeadingPathTextSeparators(
      trimmedPath.replace(/^\.\//, '')
    )

  const normalizedPath = platformCompatibility.normalizePathTextForComparison(trimmedPath)
  const normalizedRoot = platformCompatibility.normalizePathTextForComparison(projectRoot)

  if (normalizedPath === normalizedRoot) return '.'
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return null

  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '')
}
