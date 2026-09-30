/**
 * Vim 键位方案里文件编辑器的模式编辑：编辑器组件只管把这里给的扩展挂进一个 compartment（排在别的按键处理
 * 之前）。选了 Vim 方案才去加载那一层（`workbenchEditorVimLayer.ts`，连同 Vim 包），没选时这里给的是空扩展，
 * 什么也不加载。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Extension } from '@codemirror/state'

import { Log } from '@velaros-ai/core'

import type {
  WorkbenchEditorVimHost,
  WorkbenchEditorVimLayer,
} from '../models/editor/workbenchEditorVimLayer'
import { useLatest } from '../support/genericHooks'

const log = Log.tag('workbench-editor-vim')

/** 没开 Vim 时的扩展：同一个空数组，compartment 比较时不会当成换了内容。 */
const NoVimExtension: Extension = []

/**
 * `enabled`：键位方案是不是 Vim。`host`：`:w`、`:q`、`:wq`、`:wa` 落到这个编辑器上要做的事（每次渲染给新的
 * 也行，用的总是最近那一份）。
 */
export function useWorkbenchEditorVimExtension(
  enabled: boolean,
  host: WorkbenchEditorVimHost
): Extension {
  const hostRef = useLatest(host)
  const [layer, setLayer] = useState<Nullable<WorkbenchEditorVimLayer>>(null)

  useEffect(() => {
    if (!enabled || layer) return

    let active = true
    void import('../models/editor/workbenchEditorVimLayer')
      .then((module) => module.loadWorkbenchEditorVimLayer())
      .then((loaded) => {
        if (active) setLayer(loaded)
      })
      .catch((error: unknown) => {
        // 加载不出来：编辑器照 Workbench 的键位用，没有模式编辑。
        log.error('Vim 模式编辑加载失败', { error })
      })
    return () => {
      active = false
    }
  }, [enabled, layer])

  return useMemo(
    () =>
      enabled && layer
        ? layer.extension({
            save: (view) => hostRef.current.save(view),
            quit: (view) => hostRef.current.quit(view),
            saveAndQuit: (view) => hostRef.current.saveAndQuit(view),
            saveAll: (view) => hostRef.current.saveAll(view),
          })
        : NoVimExtension,
    [enabled, hostRef, layer]
  )
}
