import { useEffect, useState } from 'react'

import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import { useWorkbenchHostRuntime } from '../host/WorkbenchHostProvider'
import {
  listWorkbenchEditorConfigPaths,
  parseWorkbenchEditorConfig,
  resolveWorkbenchEditorConfig,
  type WorkbenchEditorConfigLocation,
  type WorkbenchEditorConfigProperties,
} from '../models/editor/workbenchEditorConfig'
import type { WorkbenchOpenEditorTab } from '../types/workbenchTypes'

/** `.editorconfig` 一般只有几行；再大的只读前面这些。 */
const MaxEditorConfigChars = 64 * 1024
const log = Log.tag('workbench-editor-config')

interface EditorConfigCache {
  projectRoot: string
  revision: number
  /** 按配置文件路径缓存读到的正文，没有这个文件时为 null。 */
  texts: Map<string, Promise<Nullable<string>>>
}

interface EditorConfigState {
  projectRoot: string
  path: string
  properties: WorkbenchEditorConfigProperties
}

let cache: Nullable<EditorConfigCache> = null

/**
 * 当前文件生效的 `.editorconfig` 设置：从文件所在目录一路往上读到项目根，遇到 `root = true` 为止。
 *
 * 打开着的 `.editorconfig` 直接用编辑器里的正文（改了没存也生效）；其余从磁盘读，同一个 `revision`（工作区在编辑器
 * 之外的改动次数）内缓存正文与真实缺失；读取失败不缓存，后续自然请求可以重试。
 * 还没读回来，或者读的不是这个文件时为 null。
 */
export function useWorkbenchEditorConfig({
  projectRoot,
  path,
  openTabs,
  revision,
}: {
  projectRoot: string
  path: Nullable<string>
  openTabs: readonly WorkbenchOpenEditorTab[]
  revision: number
}): Nullable<WorkbenchEditorConfigProperties> {
  const hostRuntime = useWorkbenchHostRuntime()
  const [state, setState] = useState<Nullable<EditorConfigState>>(null)
  const openConfigs = openTabs.filter((tab) => isEditorConfigPath(tab.path))
  const openConfigKey = openConfigs.map((tab) => `${tab.path}\0${tab.content}`).join('\0\0')

  useEffect(() => {
    if (!path) return undefined

    if (cache?.projectRoot !== projectRoot || cache.revision !== revision)
      cache = { projectRoot, revision, texts: new Map() }
    const texts = cache.texts
    const read = (configPath: string): Promise<Nullable<string>> => {
      const open = openConfigs.find((tab) => tab.path === configPath)
      if (open) return Promise.resolve(open.content)
      let text = texts.get(configPath)
      if (!text) {
        text = hostRuntime.kernel.project
          .readWorkbenchFile({ projectRoot, path: configPath, maxChars: MaxEditorConfigChars })
          .then((result) => Result.unwrap(result).content)
          .catch((error: unknown) => {
            const appError = AppError.from(error)
            if (appError.code === 'NOT_FOUND') return null

            if (texts.get(configPath) === text) texts.delete(configPath)
            throw appError
          })
        texts.set(configPath, text)
      }
      return text
    }

    let cancelled = false
    const configPaths = listWorkbenchEditorConfigPaths(path)
    void Promise.all(configPaths.map(read))
      .then((contents) => {
        if (cancelled) return
        const locations: WorkbenchEditorConfigLocation[] = []
        contents.forEach((content, index) => {
          if (content === null) return
          const configPath = configPaths[index]!
          locations.push({
            directory: configPath.slice(0, Math.max(0, configPath.lastIndexOf('/'))),
            file: parseWorkbenchEditorConfig(content),
          })
        })
        setState({ projectRoot, path, properties: resolveWorkbenchEditorConfig(locations, path) })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const appError = AppError.from(error)
        log.warn('读取 .editorconfig 失败', { projectRoot, path, code: appError.code, error: appError })
        setState(null)
      })
    return () => {
      cancelled = true
    }
    // openConfigs 的内容已经体现在 openConfigKey 里。
  }, [hostRuntime, openConfigKey, path, projectRoot, revision])

  return state && state.projectRoot === projectRoot && state.path === path ? state.properties : null
}

function isEditorConfigPath(path: string): boolean {
  return path === '.editorconfig' || path.endsWith('/.editorconfig')
}
