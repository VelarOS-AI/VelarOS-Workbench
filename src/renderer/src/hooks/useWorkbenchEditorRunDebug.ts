/**
 * 编辑器里「运行 / 调试」相关的扩展：测试文件的 ▶ 栏（运行与调试），JavaScript / TypeScript 文件行号上的断点，
 * 调试停下时高亮的那一行和悬停看值。编辑器组件只管把这里给的扩展挂进一个 compartment，认运行器、拼命令、
 * 记结果、存断点、问调试会话都不在组件里。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Extension } from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'

import { type WorkbenchHostRuntime } from '../host/WorkbenchHost'
import { useWorkbenchI18n } from '../i18n/WorkbenchLocalizationProvider'
import type { WorkbenchRunSessionLaunchOptions } from '../models/commands/workbenchCommandLines'
import { launchWorkbenchRunSession } from '../models/commands/workbenchRunSessionBridge'
import { isWorkbenchWindowsHost } from '../models/commands/workbenchShellQuote'
import {
  buildWorkbenchTestDebugTarget,
  buildWorkbenchTestRunCommand,
  detectWorkbenchTestRunner,
  isWorkbenchJavaScriptTestFilePath,
  pickWorkbenchTestRunner,
  readWorkbenchTestRunnerImport,
  type WorkbenchTestRunnerDetection,
} from '../models/commands/workbenchTestRunner'
import {
  isWorkbenchDebuggableFilePath,
  readWorkbenchBreakpointLines,
  setWorkbenchBreakpointLines,
  subscribeWorkbenchBreakpoints,
} from '../models/debug/workbenchBreakpoints'
import {
  getWorkbenchDebugSession,
  readWorkbenchDebugPausedLine,
  workbenchBreakpointKey,
} from '../models/debug/workbenchDebugSession'
import { createWorkbenchBreakpointGutterExtension } from '../models/editor/workbenchBreakpointGutter'
import { createWorkbenchDebugHoverExtension } from '../models/editor/workbenchDebugHover'
import { createWorkbenchDebugPausedLineExtension } from '../models/editor/workbenchDebugPausedLine'
import { focusWorkbenchEditorActions } from '../models/editor/workbenchEditorActions'
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

/**
 * 命令面板里「眼前这个编辑器」的动作归最近得到焦点的编辑器（编辑区可以拆成左右两组）：焦点进来就登记一下。
 */
const focusedEditorTracker = ViewPlugin.fromClass(
  class {
    public constructor(view: EditorView) {
      if (view.hasFocus) focusWorkbenchEditorActions(view)
    }
  },
  {
    eventHandlers: {
      focus(_event, view) {
        focusWorkbenchEditorActions(view)
      },
    },
  }
)

/** 测试文件的 ▶ 栏：认出了运行器才有。 */
function useWorkbenchTestRunExtension({
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
    /**
     * 起一张卡跑（或调试）这个目标。跑的那张卡的结果记到标记上；调试的不记——在断点上停久了，运行器自己
     * 会报超时（Vitest 的 worker 调用 60 秒超时），测试明明过了退出码却是 1，半路结束调试也一样不算数，
     * 所以调试完标记还是上一次正常运行的结论。
     */
    const launch = (target: WorkbenchTestRunTarget, view: EditorView, debug: boolean): void => {
      // 两个运行器都有依据时，看这个文件自己引的是哪个。
      const runner = pickWorkbenchTestRunner(
        detection.evidence,
        readWorkbenchTestRunnerImport(view.state.sliceDoc(0, 20_000))
      )
      if (!runner) return

      const test = {
        project: { ...detection, runner },
        filePath: path,
        pattern: target.pattern,
        windows: isWorkbenchWindowsHost(),
      }
      const name = target.title || fileNameOf(path)
      const options: WorkbenchRunSessionLaunchOptions = {}
      if (detection.packageDir) options.cwd = detection.packageDir
      if (debug) options.debug = { target: buildWorkbenchTestDebugTarget(test) }
      void launchWorkbenchRunSession(
        // 调试时这条命令只是卡片上写的那一行：真正执行的由调试器带着检查器去起。
        buildWorkbenchTestRunCommand(test),
        debug ? t('workbench.debuggerRunCardTitle', { name }) : name,
        options
      ).then((sessionId) => {
        if (sessionId && !debug) trackWorkbenchTestRun(resultKey(target), sessionId)
      })
    }

    return createWorkbenchTestRunGutterExtension({
      labels: {
        runFile: t('workbench.editorTestRunFile'),
        runTest: (title) => t('workbench.editorTestRun', { title }),
        runSuite: (title) => t('workbench.editorTestRunSuite', { title }),
        debugFile: t('workbench.editorTestDebugFile'),
        debugTest: (title) => t('workbench.editorTestDebug', { title }),
        debugSuite: (title) => t('workbench.editorTestDebugSuite', { title }),
        status: {
          running: t('workbench.editorTestStatusRunning'),
          passed: t('workbench.editorTestStatusPassed'),
          failed: t('workbench.editorTestStatusFailed'),
        },
      },
      readStatus: (target) => readWorkbenchTestRunStatus(resultKey(target)),
      subscribeStatus: subscribeWorkbenchTestRunResults,
      onRun: (target, view) => launch(target, view, false),
      onDebug: (target, view) => launch(target, view, true),
    })
  }, [detection, disabled, path, projectRoot, t])
}

/** 断点、停下时的那一行、悬停看值：JavaScript / TypeScript 文件才有。 */
function useWorkbenchDebugEditorExtension({
  projectRoot,
  path,
  disabled,
}: Pick<UseWorkbenchEditorRunDebugOptions, 'projectRoot' | 'path' | 'disabled'>): Extension {
  return useMemo(() => {
    if (!path || disabled || !isWorkbenchDebuggableFilePath(path)) return []

    const session = getWorkbenchDebugSession()
    const pausedLine = (): ReturnType<typeof readWorkbenchDebugPausedLine> =>
      readWorkbenchDebugPausedLine(session.getSnapshot(), projectRoot, path)
    return [
      createWorkbenchBreakpointGutterExtension({
        readLines: () => readWorkbenchBreakpointLines(projectRoot, path),
        writeLines: (lines) => setWorkbenchBreakpointLines(projectRoot, path, lines),
        subscribeLines: subscribeWorkbenchBreakpoints,
        readVerified: (line) => {
          const snapshot = session.getSnapshot()
          if (snapshot.session?.projectRoot !== projectRoot) return null
          return snapshot.breakpointStatuses.get(workbenchBreakpointKey(path, line))?.verified ?? null
        },
        subscribeVerified: session.subscribe,
      }),
      createWorkbenchDebugPausedLineExtension({
        readPausedLine: pausedLine,
        subscribe: session.subscribe,
      }),
      createWorkbenchDebugHoverExtension({
        // 只在选中的那一帧所在的文件里求值：别的文件里同名的变量不是一回事。
        isActive: () => pausedLine() !== null,
        evaluate: async (expression) => {
          const { value } = await session.evaluate(expression, { sideEffectFree: true })
          return value && value.text ? value.text : null
        },
      }),
    ]
  }, [disabled, path, projectRoot])
}

export function useWorkbenchEditorRunDebugExtension(
  options: UseWorkbenchEditorRunDebugOptions
): Extension {
  const testRun = useWorkbenchTestRunExtension(options)
  const debug = useWorkbenchDebugEditorExtension(options)
  const tracked = !!options.path && !options.disabled
  return useMemo(
    () => (tracked ? [focusedEditorTracker, testRun, debug] : []),
    [debug, testRun, tracked]
  )
}
