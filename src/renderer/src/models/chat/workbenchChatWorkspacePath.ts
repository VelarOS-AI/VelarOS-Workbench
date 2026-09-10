import { currentSystemPlatform as systemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'

/** 回答里的路径 → 相对项目根的路径；项目根之外的绝对路径返回 null，项目根本身返回 `.`。 */
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

/** 回答里的路径 → 绝对路径：相对路径按项目根拼，`~/` 与绝对路径原样。 */
export function resolveWorkbenchChatAbsolutePath(path: string, projectRoot: string): string {
  const trimmedPath = path.trim()
  if (
    !trimmedPath
    || !projectRoot.trim()
    || systemPlatformCompatibility.isAbsolutePathText(trimmedPath)
    || /^~[\\/]/u.test(trimmedPath)
  )
    return trimmedPath

  return systemPlatformCompatibility.joinPathText(
    projectRoot.trim(),
    systemPlatformCompatibility.stripLeadingPathTextSeparators(trimmedPath.replace(/^\.\//u, ''))
  )
}

/** 显示用：项目根之内的绝对路径显示成相对项目根的路径（与 Desktop 相同），其余原样。 */
export function formatWorkbenchChatPathForDisplay(path: string, projectRoot: string): string {
  const trimmedPath = path.trim()
  if (
    !trimmedPath
    || !projectRoot.trim()
    || !systemPlatformCompatibility.isAbsolutePathText(trimmedPath)
  )
    return trimmedPath

  const relativePath = resolveWorkbenchChatWorkspacePath(trimmedPath, projectRoot)
  return relativePath && relativePath !== '.' ? relativePath : trimmedPath
}
