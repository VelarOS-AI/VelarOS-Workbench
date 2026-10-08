import { isArray,Log } from '@velaros-ai/core'
import {
  isRecord,
  readNumberScalar as readNumber,
  readStringScalar as readString,
} from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../support/localStorageJsonStore'
import {
  createWorkbenchEditorGroupsLayout,
  normalizeWorkbenchEditorGroupsLayout,
  type WorkbenchEditorGroupsLayout,
} from '../editor/workbenchEditorGroups'
import { ROOT_PATH } from '../shared/workbenchUtils'

const STORAGE_KEY = 'velaros.workbench.project-session.v1'
const MAX_PERSISTED_OPEN_TABS = 32
const MAX_PERSISTED_EXPANDED_PATHS = 240
const log = Log.tag('workbench-project-session')

export interface PersistedWorkbenchEditorCursor {
  line: number
  column: number
}

export interface PersistedWorkbenchProjectSession {
  version: 1
  expandedPaths: string[]
  selectedEntryPath: Nullable<string>
  /** 编辑区的标签布局：开着哪些标签、标签栏顺序、每组的当前标签、当前组。 */
  editorLayout: WorkbenchEditorGroupsLayout
  cursorByPath: Record<string, PersistedWorkbenchEditorCursor>
}

export interface WorkbenchProjectSessionSnapshot {
  expandedPaths: Iterable<string>
  selectedEntryPath: Nullable<string>
  editorLayout: WorkbenchEditorGroupsLayout
  cursorByPath: Record<string, PersistedWorkbenchEditorCursor>
}

const EMPTY_SESSION: PersistedWorkbenchProjectSession = {
  version: 1,
  expandedPaths: [ROOT_PATH],
  selectedEntryPath: null,
  editorLayout: createWorkbenchEditorGroupsLayout(),
  cursorByPath: {},
}

function normalizeCursor(value: unknown): Nullable<PersistedWorkbenchEditorCursor> {
  if (!isRecord(value)) return null

  const line = readNumber(value.line)
  const column = readNumber(value.column)
  if (!line || !column) return null

  return { line, column }
}

function normalizeStringList(value: unknown, limit: number): string[] {
  if (!isArray(value)) return []

  const seen = new Set<string>()
  const items: string[] = []

  for (const item of value) {
    const path = readString(item)?.trim()
    if (!path || seen.has(path)) continue

    seen.add(path)
    items.push(path)
    if (items.length >= limit) break
  }

  return items
}

function normalizeCursorByPath(value: unknown): Record<string, PersistedWorkbenchEditorCursor> {
  if (!isRecord(value)) return {}

  const next: Record<string, PersistedWorkbenchEditorCursor> = {}

  for (const [path, cursorValue] of Object.entries(value)) {
    const normalizedPath = readString(path)?.trim()
    const cursor = normalizeCursor(cursorValue)
    if (!normalizedPath || !cursor) continue

    next[normalizedPath] = cursor
  }

  return next
}

export function normalizeWorkbenchProjectSession(
  value: unknown
): PersistedWorkbenchProjectSession {
  if (!isRecord(value)) return EMPTY_SESSION

  const expandedPaths = normalizeStringList(value.expandedPaths, MAX_PERSISTED_EXPANDED_PATHS)
  const selectedEntryPath = readString(value.selectedEntryPath)
  const cursorByPath = normalizeCursorByPath(value.cursorByPath)

  return {
    version: 1,
    expandedPaths: expandedPaths.length > 0 ? expandedPaths : [ROOT_PATH],
    selectedEntryPath: selectedEntryPath || null,
    // 存的不是这个形状（包括只有一列标签路径的旧会话）：按没有标签处理，不去换算。
    editorLayout: normalizeWorkbenchEditorGroupsLayout(value.editorLayout, MAX_PERSISTED_OPEN_TABS),
    cursorByPath,
  }
}

export function buildWorkbenchProjectSessionSnapshot(
  snapshot: WorkbenchProjectSessionSnapshot
): PersistedWorkbenchProjectSession {
  const expandedPaths = normalizeStringList([...snapshot.expandedPaths], MAX_PERSISTED_EXPANDED_PATHS)

  return normalizeWorkbenchProjectSession({
    version: 1,
    expandedPaths: expandedPaths.length > 0 ? expandedPaths : [ROOT_PATH],
    selectedEntryPath: snapshot.selectedEntryPath,
    editorLayout: snapshot.editorLayout,
    cursorByPath: snapshot.cursorByPath,
  })
}

type PersistedWorkbenchProjectSessionMap = Record<string, PersistedWorkbenchProjectSession>

function normalizeSessionMap(value: unknown): PersistedWorkbenchProjectSessionMap {
  if (!isRecord(value)) return {}

  const next: PersistedWorkbenchProjectSessionMap = {}

  for (const [projectId, sessionValue] of Object.entries(value)) {
    const id = readString(projectId)?.trim()
    if (!id) continue

    next[id] = normalizeWorkbenchProjectSession(sessionValue)
  }

  return next
}

const workbenchProjectSessionStore = createLocalStorageJsonStore<PersistedWorkbenchProjectSessionMap>({
  key: STORAGE_KEY,
  fallback: () => ({}),
  normalize: normalizeSessionMap,
  log,
  readErrorMessage: '读取 workbench 项目会话失败，使用空会话',
  writeErrorMessage: '写入 workbench 项目会话失败',
})

export function readWorkbenchProjectSession(
  projectId: string,
  storage?: StorageLike
): Nullable<PersistedWorkbenchProjectSession> {
  const id = projectId.trim()
  if (!id) return null

  const session = workbenchProjectSessionStore.read(storage)[id]
  return session ?? null
}

export function saveWorkbenchProjectSession(
  projectId: string,
  session: PersistedWorkbenchProjectSession,
  storage?: StorageLike
): void {
  const id = projectId.trim()
  if (!id) return

  const map = workbenchProjectSessionStore.read(storage)
  workbenchProjectSessionStore.write(
    {
      ...map,
      [id]: normalizeWorkbenchProjectSession(session),
    },
    storage
  )
}

export function saveWorkbenchProjectSessionSnapshot(
  projectId: string,
  snapshot: WorkbenchProjectSessionSnapshot,
  storage?: StorageLike
): void {
  saveWorkbenchProjectSession(projectId, buildWorkbenchProjectSessionSnapshot(snapshot), storage)
}
