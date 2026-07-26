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

/**
 * 0.3.x 已发布的结构化存储契约。宿主可以继续提供自己的实现。
 */
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
  return typeof fallback === 'function'
    ? (fallback as () => T)()
    : cloneFallbackValue(fallback)
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

/**
 * JSON persistence object with explicit storage, normalization, fallback, and logging boundaries.
 */
export class JsonStorageStore<T> implements LocalStorageJsonStore<T> {
  private readonly key: string
  private readonly fallback: T | (() => T)
  private readonly normalize?: (value: unknown) => T
  private readonly storage?: StorageLike
  private readonly log?: WorkbenchStorageLogger
  private readonly readErrorLevel: 'debug' | 'warn'
  private readonly readErrorMessage?: string
  private readonly writeErrorLevel: 'debug' | 'warn'
  private readonly writeErrorMessage?: string
  private readonly removeErrorLevel: 'debug' | 'warn'
  private readonly removeErrorMessage?: string

  public constructor({
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
  }: LocalStorageJsonStoreOptions<T>) {
    if (!key.trim()) throw new TypeError('JsonStorageStore key must not be empty')

    this.key = key
    this.fallback = fallback
    this.normalize = normalize
    this.storage = storage
    this.log = log
    this.readErrorLevel = readErrorLevel
    this.readErrorMessage = readErrorMessage
    this.writeErrorLevel = writeErrorLevel
    this.writeErrorMessage = writeErrorMessage
    this.removeErrorLevel = removeErrorLevel
    this.removeErrorMessage = removeErrorMessage
  }

  public readonly read = (storageOverride?: StorageLike): T => {
    try {
      const raw = resolveStorage(storageOverride ?? this.storage).getItem(this.key)
      if (!raw) return resolveFallback(this.fallback)

      const parsed: unknown = JSON.parse(raw)
      return this.normalize ? this.normalize(parsed) : (parsed as T)
    } catch (error) {
      logStorageError(
        this.log,
        this.readErrorLevel,
        this.readErrorMessage,
        this.key,
        error
      )
      return resolveFallback(this.fallback)
    }
  }

  public readonly write = (value: T, storageOverride?: StorageLike): void => {
    try {
      resolveStorage(storageOverride ?? this.storage).setItem(this.key, JSON.stringify(value))
    } catch (error) {
      logStorageError(
        this.log,
        this.writeErrorLevel,
        this.writeErrorMessage,
        this.key,
        error
      )
    }
  }

  public readonly update = (
    updater: (current: T) => T,
    storageOverride?: StorageLike
  ): T => {
    const next = updater(this.read(storageOverride))
    this.write(next, storageOverride)
    return next
  }

  public readonly remove = (storageOverride?: StorageLike): void => {
    try {
      resolveStorage(storageOverride ?? this.storage).removeItem(this.key)
    } catch (error) {
      logStorageError(
        this.log,
        this.removeErrorLevel,
        this.removeErrorMessage,
        this.key,
        error
      )
    }
  }
}

/** Compatibility factory for existing model modules. */
export function createLocalStorageJsonStore<T>(
  options: LocalStorageJsonStoreOptions<T>
): LocalStorageJsonStore<T> {
  return new JsonStorageStore(options)
}
