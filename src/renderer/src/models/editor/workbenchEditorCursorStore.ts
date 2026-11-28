export interface WorkbenchEditorCursorSnapshot {
  line: number
  column: number
  selection?: {
    startLine: number
    endLine: number
    startColumn: number
    endColumn: number
  }
}

export interface WorkbenchEditorFrameStore<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  set: (value: T) => void
}

export function createWorkbenchEditorFrameStore<T>(
  initial: T,
  same: (left: T, right: T) => boolean = Object.is
): WorkbenchEditorFrameStore<T> {
  let current = initial
  let frame: number | null = null
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && frame !== null) {
          cancelAnimationFrame(frame)
          frame = null
        }
      }
    },
    set(value) {
      if (same(current, value)) return
      current = value
      if (frame === null && listeners.size > 0) {
        frame = requestAnimationFrame(() => {
          frame = null
          for (const listener of listeners) listener()
        })
      }
    },
  }
}

export function createWorkbenchEditorCursorStore(): WorkbenchEditorCursorStore {
  return createWorkbenchEditorFrameStore<WorkbenchEditorCursorSnapshot>(
    { line: 1, column: 1 },
    (left, right) => !left.selection && !right.selection &&
      left.line === right.line && left.column === right.column
  )
}

export type WorkbenchEditorCursorStore = WorkbenchEditorFrameStore<WorkbenchEditorCursorSnapshot>
