export type StorageLike = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

export interface WorkbenchStorageLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

export interface LocalStorageJsonStoreOptions<T> {
  key: string
  fallback: T | (() => T)
  normalize?: (value: unknown) => T
  storage?: StorageLike
  log?: WorkbenchStorageLogger
  readErrorLevel?: 'debug' | 'warn'
  readErrorMessage?: string
  writeErrorLevel?: 'debug' | 'warn'
  writeErrorMessage?: string
  removeErrorLevel?: 'debug' | 'warn'
  removeErrorMessage?: string
}

/** JSON 存储操作；每次调用可显式覆盖注入的存储。 */
export interface LocalStorageJsonStore<T> {
  read: (storage?: StorageLike) => T
  write: (value: T, storage?: StorageLike) => void
  update: (updater: (current: T) => T, storage?: StorageLike) => T
  remove: (storage?: StorageLike) => void
}

function cloneFallbackValue<T>(value: T): T {
  if (!value || typeof value !== 'object') return value

  try {
    return structuredClone(value)
  } catch {
    return Array.isArray(value)
      ? ([...value] as T)
      : ({ ...(value as Record<string, unknown>) } as T)
  }
}

function resolveFallback<T>(fallback: T | (() => T)): T {
  return typeof fallback === 'function' ? (fallback as () => T)() : cloneFallbackValue(fallback)
}

function resolveStorage(storage?: StorageLike): StorageLike {
  if (storage) return storage

  const defaultStorage = globalThis.localStorage
  if (!defaultStorage) throw new Error('Workbench local storage is unavailable in this host')
  return defaultStorage
}

function logStorageError(
  log: WorkbenchStorageLogger | undefined,
  level: 'debug' | 'warn',
  message: string | undefined,
  key: string,
  error: unknown
): void {
  if (!message) return
  log?.[level]?.(message, { key, error: String(error) })
}

/** JSON 持久化：存储、归一化、默认值和诊断由产品模型显式提供。 */
export function createLocalStorageJsonStore<T>({
  key,
  fallback,
  normalize,
  storage,
  log,
  readErrorLevel = 'debug',
  readErrorMessage,
  writeErrorLevel = 'warn',
  writeErrorMessage,
  removeErrorLevel = 'warn',
  removeErrorMessage,
}: LocalStorageJsonStoreOptions<T>): LocalStorageJsonStore<T> {
  if (!key.trim()) throw new TypeError('JsonStorageStore key must not be empty')

  const read = (storageOverride?: StorageLike): T => {
    try {
      const raw = resolveStorage(storageOverride ?? storage).getItem(key)
      if (!raw) return resolveFallback(fallback)

      const parsed: unknown = JSON.parse(raw)
      return normalize ? normalize(parsed) : (parsed as T)
    } catch (error) {
      logStorageError(log, readErrorLevel, readErrorMessage, key, error)
      return resolveFallback(fallback)
    }
  }

  const write = (value: T, storageOverride?: StorageLike): void => {
    try {
      resolveStorage(storageOverride ?? storage).setItem(key, JSON.stringify(value))
    } catch (error) {
      logStorageError(log, writeErrorLevel, writeErrorMessage, key, error)
    }
  }

  const update = (updater: (current: T) => T, storageOverride?: StorageLike): T => {
    const next = updater(read(storageOverride))
    write(next, storageOverride)
    return next
  }

  const remove = (storageOverride?: StorageLike): void => {
    try {
      resolveStorage(storageOverride ?? storage).removeItem(key)
    } catch (error) {
      logStorageError(log, removeErrorLevel, removeErrorMessage, key, error)
    }
  }

  return { read, write, update, remove }
}
