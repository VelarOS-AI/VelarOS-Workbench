import { startTransition, useCallback, useEffect, useRef, useState } from 'react'

const EditorSnapshotQuietPeriodMs = 120

/** Commands see each edit immediately. The surrounding React UI publishes after a typing pause. */
export function useWorkbenchEditorSnapshot<T>(initial: () => T) {
  const [snapshot, setSnapshot] = useState(initial)
  const live = useRef(snapshot)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const publish = useCallback((value: T, defer = false): void => {
    live.current = value
    if (timer.current !== null) clearTimeout(timer.current)
    if (!defer) {
      timer.current = null
      setSnapshot(value)
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      const next = live.current
      startTransition(() => setSnapshot(next))
    }, EditorSnapshotQuietPeriodMs)
  }, [])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    },
    []
  )

  return [snapshot, live, publish] as const
}
