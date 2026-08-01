import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isPresent } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { systemPlatformCompatibility } from '@velaros-ai/system-tools/platform-compatibility'

export interface PathContainmentPlatform {
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

const DefaultPathPlatform: PathContainmentPlatform = {
  isAbsolute,
  relative,
  resolve,
  sep,
}

function isRelativePathInsideRoot(
  relativePath: string,
  platform: PathContainmentPlatform = DefaultPathPlatform
): boolean {
  return (
    isEmpty(relativePath)
    || relativePath === '.'
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${platform.sep}`)
      && !platform.isAbsolute(relativePath)
    )
  )
}

function getRelativePathInsideRoot(
  rootPath: string,
  candidatePath: string,
  platform: PathContainmentPlatform = DefaultPathPlatform
): Nullable<string> {
  const relativePath = platform.relative(
    platform.resolve(rootPath),
    platform.resolve(candidatePath)
  )
  return isRelativePathInsideRoot(relativePath, platform) ? relativePath || '.' : null
}

function isPathInsideRoot(
  rootPath: string,
  candidatePath: string,
  platform: PathContainmentPlatform = DefaultPathPlatform
): boolean {
  return isPresent(getRelativePathInsideRoot(rootPath, candidatePath, platform))
}

function toPortableRelativePath(
  relativePath: string,
  platform: PathContainmentPlatform = DefaultPathPlatform
): string {
  return systemPlatformCompatibility.toPortablePathText(relativePath.split(platform.sep).join('/'))
}

export {
  getRelativePathInsideRoot,
  isPathInsideRoot,
  isRelativePathInsideRoot,
  toPortableRelativePath,
}
