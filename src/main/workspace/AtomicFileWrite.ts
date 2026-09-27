/**
 * 保存用的原子写：在同一目录写临时文件、刷盘，再 rename 盖过目标。中途崩溃或断电时磁盘上要么是
 * 旧文件、要么是新文件，不会留下写了一半的文件。临时文件沿用目标的权限位。
 *
 * rename 换掉的是整个 inode，下面几种情况会因此改掉文件的身份，只能退回原地写（不原子）：
 * - 有多个硬链接：其它链接会继续指向旧内容；
 * - 文件不属于当前用户：新文件的属主会变成当前用户；
 * - 目录里建不了临时文件（目录没有写权限）：文件本身可写时照样要能存。
 * 目标本身不可写时照旧报错，不借 rename 绕过只读。
 */
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { access, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** 保存目标写之前的状态（`fs.Stats` 的子集）。 */
interface AtomicWriteTarget {
  mode: number
  nlink: number
  uid: number
}

const TemporarySaveSuffix = '.velaros-save'

/** 保存时临时文件的名字：隐藏文件，与目标同目录，文件监听据此略过。 */
function isWorkbenchSaveTemporaryName(name: string): boolean {
  return name.startsWith('.') && name.endsWith(TemporarySaveSuffix)
}

async function writeFileAtomically(
  path: string,
  bytes: Uint8Array,
  target: AtomicWriteTarget
): Promise<void> {
  if (mustWriteInPlace(target)) {
    await writeFile(path, bytes)
    return
  }

  await access(path, constants.W_OK)
  const temporaryPath = temporaryPathFor(path)
  const handle = await open(temporaryPath, 'wx', permissionBits(target)).catch(
    (error: unknown) => {
      if (isPermissionError(error)) return null
      throw error
    }
  )
  if (!handle) {
    await writeFile(path, bytes)
    return
  }

  try {
    try {
      await handle.writeFile(bytes)
      // open 给的权限位会被 umask 削掉，这里补回与目标一致。
      await handle.chmod(permissionBits(target))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

/** beforeunload 兜底保存用的同步版本，语义与 {@link writeFileAtomically} 相同。 */
function writeFileAtomicallySync(path: string, bytes: Uint8Array, target: AtomicWriteTarget): void {
  if (mustWriteInPlace(target)) {
    writeFileSync(path, bytes)
    return
  }

  accessSync(path, constants.W_OK)
  const temporaryPath = temporaryPathFor(path)
  let descriptor: number
  try {
    descriptor = openSync(temporaryPath, 'wx', permissionBits(target))
  } catch (error) {
    if (!isPermissionError(error)) throw error
    writeFileSync(path, bytes)
    return
  }

  try {
    try {
      writeFileSync(descriptor, bytes)
      fchmodSync(descriptor, permissionBits(target))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporaryPath, path)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function mustWriteInPlace(target: AtomicWriteTarget): boolean {
  const currentUid = process.getuid?.()
  return target.nlink > 1 || (currentUid !== undefined && target.uid !== currentUid)
}

function temporaryPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}${TemporarySaveSuffix}`)
}

function permissionBits(target: AtomicWriteTarget): number {
  return target.mode & 0o7777
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM'
}

export { isWorkbenchSaveTemporaryName, writeFileAtomically, writeFileAtomicallySync }
export type { AtomicWriteTarget }
