import { realpathSync, type Stats, statSync } from 'node:fs'
import { createRequire } from 'node:module'

interface FileIdentityFs {
  realpath: (path: string) => string
  stat: (path: string) => Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'isFile'>
  statArchive?: FileIdentityFs['stat']
}

const require = createRequire(import.meta.url)
const originalFs = process.versions['electron']
  ? (require('original-fs') as Pick<typeof import('node:fs'), 'statSync'>)
  : { statSync }
const nativeFs: FileIdentityFs = {
  realpath: realpathSync,
  stat: statSync,
  statArchive: originalFs.statSync,
}

/** ASAR entries have synthetic inode/timestamp fields. Bind them to the real archive instead. */
export function externalLspFileIdentity(
  path: string,
  filesystem: FileIdentityFs = nativeFs
): string {
  try {
    const canonical = filesystem.realpath(path)
    const archive = /^(.*?\.asar)(?:[/\\]|$)/iu.exec(canonical)?.[1]
    const archiveStats = archive ? (filesystem.statArchive ?? filesystem.stat)(archive) : null
    const value = archiveStats?.isFile() ? archiveStats : filesystem.stat(canonical)
    return `${path}:${canonical}:${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`
  } catch {
    return `${path}:missing`
  }
}
