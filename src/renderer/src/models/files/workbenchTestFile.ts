const TEST_FILE_NAME_PATTERN = /\.(?:spec|test)\.[^./\\]+$/iu
const TEST_DIRECTORY_NAME_PATTERN = /^(?:__tests__|tests?)$/iu

/** Recognizes conventional test-file names without treating every file under tests/ as executable. */
export function isWorkbenchTestFilePath(path: Nullable<string>): boolean {
  if (!path) return false

  const normalized = path.replace(/\\/g, '/')
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  return TEST_FILE_NAME_PATTERN.test(fileName)
}

/** Marks conventional test roots without tinting unrelated parent directories. */
export function isWorkbenchTestDirectoryPath(path: Nullable<string>): boolean {
  if (!path) return false

  const normalized = path.replace(/\\/g, '/').replace(/\/$/u, '')
  const directoryName = normalized.slice(normalized.lastIndexOf('/') + 1)
  return TEST_DIRECTORY_NAME_PATTERN.test(directoryName)
}
