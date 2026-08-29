export function resolveWorkbenchClipboardFilePath(
  file: File,
  readNativePath: (file: File) => string
): string {
  try {
    const nativePath = readNativePath(file).trim()
    if (nativePath) return nativePath
  } catch {
    // Continue with the shared VelarOS clipboard metadata.
  }

  const restoredPath = (file as File & { path?: unknown }).path
  return typeof restoredPath === 'string' ? restoredPath.trim() : ''
}
