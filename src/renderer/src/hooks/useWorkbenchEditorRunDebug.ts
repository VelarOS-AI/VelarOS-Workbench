/**
 * 编辑器里「运行 / 调试」相关的扩展：测试文件的 ▶ 栏。编辑器组件只管把这里给的扩展挂进一个 compartment，
 * 认运行器、拼命令、记结果都不在组件里。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import type { WorkbenchHostRuntime } from '../host'
import { useWorkbenchI18n } from '../i18n'
import { launchWorkbenchRunSession } from '../models/commands/workbenchRunSessionBridge'
import {
  buildWorkbenchTestRunCommand,
  detectWorkbenchTestRunner,
  isWorkbenchJavaScriptTestFilePath,
  pickWorkbenchTestRunner,
  readWorkbenchTestRunnerImport,
  type WorkbenchTestRunnerDetection,
} from '../models/commands/workbenchTestRunner'
import {
  createWorkbenchTestRunGutterExtension,
  type WorkbenchTestRunTarget,
} from '../models/editor/workbenchTestRunGutter'
import {
  readWorkbenchTestRunStatus,
  subscribeWorkbenchTestRunResults,
  trackWorkbenchTestRun,
  workbenchTestRunResultKey,
} from '../models/editor/workbenchTestRunResults'

interface UseWorkbenchEditorRunDebugOptions {
  projectRoot: string
  path: Nullable<string>
  /** 编辑器整个不能用时不标 ▶。 */
  disabled: boolean
  /** 工作区在编辑器之外被改动的次数：变了就重新认一次运行器（`package.json`、配置文件可能变了）。 */
  externalRevision: number
  hostRuntime: WorkbenchHostRuntime
}

interface CachedDetection {
  revision: number
  detection: Promise<Nullable<WorkbenchTestRunnerDetection>>
}

/** 同一个目录里的测试文件共用一次识别：键是「项目根 + 文件所在目录」，工作区变了（序号不同）再重认。 */
const detections = new Map<string, CachedDetection>()
const MaxCachedDetections = 64

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')))
}

function fileNameOf(path: string): string {
  return path.replace(/\\/gu, '/').split('/').at(-1) ?? path
}

function detectCached(
  projectRoot: string,
  path: string,
  revision: number,
  hostRuntime: WorkbenchHostRuntime
): Promise<Nullable<WorkbenchTestRunnerDetection>> {
  const key = `${projectRoot}\0${directoryOf(path)}`
  const cached = detections.get(key)
  if (cached?.revision === revision) return cached.detection

  const detection = detectWorkbenchTestRunner(path, {
    findExistingFiles: async (paths) => {
      const result = await hostRuntime.kernel.project.findExistingWorkbenchFiles({
        projectRoot,
        paths,
      })
      return result.ok ? result.data.paths : []
    },
    readFile: async (filePath) => {
      const result = await hostRuntime.kernel.project.readWorkbenchFile({
        projectRoot,
        path: filePath,
        maxChars: 200_000,
      })
      return result.ok ? result.data.content : null
    },
  }).catch(() => null)
  detections.delete(key)
  detections.set(key, { revision, detection })
  while (detections.size > MaxCachedDetections) {
    const oldest = detections.keys().next().value
    if (oldest === undefined) break
    detections.delete(oldest)
  }
  return detection
}

/** 当前文件归哪个测试运行器跑；不是 JS / TS 测试文件、或者项目里没有 Vitest / Jest 的依据，是 null。 */
function useWorkbenchTestRunnerDetection({
  projectRoot,
  path,
  externalRevision,
  hostRuntime,
}: Omit<UseWorkbenchEditorRunDebugOptions, 'disabled'>): Nullable<WorkbenchTestRunnerDetection> {
  const testPath = isWorkbenchJavaScriptTestFilePath(path) ? path : null
  const scope = testPath ? `${projectRoot}\0${directoryOf(testPath)}` : null
  // 结果按内容记：重认一遍结论没变时不换对象，▶ 栏不必重建。
  const [detected, setDetected] = useState<{ scope: string; serialized: string }>()

  useEffect(() => {
    if (!testPath || !scope) return undefined

    let cancelled = false
    void detectCached(projectRoot, testPath, externalRevision, hostRuntime).then((detection) => {
      if (cancelled) return
      const serialized = JSON.stringify(detection)
      setDetected((current) =>
        current?.scope === scope && current.serialized === serialized
          ? current
          : { scope, serialized }
      )
    })
    return () => {
      cancelled = true
    }
  }, [externalRevision, hostRuntime, projectRoot, scope, testPath])

  const serialized = scope && detected?.scope === scope ? detected.serialized : null
  return useMemo(
    () => (serialized ? (JSON.parse(serialized) as Nullable<WorkbenchTestRunnerDetection>) : null),
    [serialized]
  )
}

export function useWorkbenchEditorRunDebugExtension({
  projectRoot,
  path,
  disabled,
  externalRevision,
  hostRuntime,
}: UseWorkbenchEditorRunDebugOptions): Extension {
  const { t } = useWorkbenchI18n()
  const detection = useWorkbenchTestRunnerDetection({
    projectRoot,
    path,
    externalRevision,
    hostRuntime,
  })

  return useMemo(() => {
    if (!path || !detection || disabled) return []

    const resultKey = (target: WorkbenchTestRunTarget): string =>
      workbenchTestRunResultKey(projectRoot, path, target.pattern ?? '')
    const run = (target: WorkbenchTestRunTarget, view: EditorView): void => {
      // 两个运行器都有依据时，看这个文件自己引的是哪个。
      const runner = pickWorkbenchTestRunner(
        detection.evidence,
        readWorkbenchTestRunnerImport(view.state.sliceDoc(0, 20_000))
      )
      if (!runner) return

      const command = buildWorkbenchTestRunCommand({
        project: { ...detection, runner },
        filePath: path,
        pattern: target.pattern,
        windows: /\bWindows\b/iu.test(navigator.userAgent),
      })
      void launchWorkbenchRunSession(
        command,
        target.title || fileNameOf(path),
        detection.packageDir ? { cwd: detection.packageDir } : undefined
      ).then((sessionId) => {
        if (sessionId) trackWorkbenchTestRun(resultKey(target), sessionId)
      })
    }

    return createWorkbenchTestRunGutterExtension({
      labels: {
        runFile: t('workbench.editorTestRunFile'),
        runTest: (title) => t('workbench.editorTestRun', { title }),
        runSuite: (title) => t('workbench.editorTestRunSuite', { title }),
        status: {
          running: t('workbench.editorTestStatusRunning'),
          passed: t('workbench.editorTestStatusPassed'),
          failed: t('workbench.editorTestStatusFailed'),
        },
      },
      readStatus: (target) => readWorkbenchTestRunStatus(resultKey(target)),
      subscribeStatus: subscribeWorkbenchTestRunResults,
      onRun: run,
    })
  }, [detection, disabled, path, projectRoot, t])
}
