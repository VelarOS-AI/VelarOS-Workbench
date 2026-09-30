/**
 * 底部的调试面板：一排控制按钮（继续 / 暂停、单步跳过、进入、跳出、结束），左边调用栈，中间按作用域分的变量
 * （对象点开才去取它的属性），右边一个表达式输入框，在选中的那一帧里求值。
 *
 * 状态都在调试会话里（`models/debug/workbenchDebugSession.ts`），这里只订阅、只画。按需加载：第一次打开调试
 * 面板才来，不进工作区外壳包。
 */
import {
  type FormEvent,
  memo,
  type ReactElement,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  ArrowArcRightIcon,
  ArrowLineDownIcon,
  ArrowLineUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  readWorkbenchExceptionPause,
  setWorkbenchExceptionPause,
  subscribeWorkbenchBreakpoints,
} from '@renderer/models/debug/workbenchBreakpoints'
import type { WorkbenchDebugAction } from '@renderer/models/debug/workbenchDebugBridge'
import {
  getWorkbenchDebugSession,
  type WorkbenchDebugEnd,
  type WorkbenchDebugPause,
  type WorkbenchDebugSessionController,
} from '@renderer/models/debug/workbenchDebugSession'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'

import type {
  WorkbenchDebuggerFrame,
  WorkbenchDebuggerScope,
  WorkbenchDebuggerValue,
  WorkbenchDebuggerVariablesResult,
} from '@shared/workbenchDebugger'

import styles from './WorkbenchDebugPanel.module.css'

export interface WorkbenchDebugPanelProps {
  projectRoot: string
  /** 各个动作此刻的快捷键（按当前键位与平台写好的提示）；没有的不写。 */
  shortcutHints: Partial<Record<WorkbenchDebugAction, string>>
  /** 调试会话；不给就是这个窗口的那一个（测试里换成假的）。 */
  session?: WorkbenchDebugSessionController
}

type Translate = ReturnType<typeof useWorkbenchI18n>['t']

/** 表达式求过的一次结果。 */
interface EvaluationEntry {
  id: number
  expression: string
  value: Nullable<WorkbenchDebuggerValue>
  error: Nullable<string>
  /** 求值时是第几次停下：程序继续跑过之后，那时拿到的对象已经作废，不能再展开。 */
  pauseSequence: Nullable<number>
}

const MaxEvaluationEntries = 30

function fileNameOf(path: string): string {
  return path.replace(/\\/gu, '/').split('/').at(-1) ?? path
}

function describeStatus(
  t: Translate,
  active: boolean,
  pause: Nullable<WorkbenchDebugPause>,
  lastEnd: Nullable<WorkbenchDebugEnd>
): string {
  if (pause) {
    switch (pause.reason) {
      case 'breakpoint':
        return t('workbench.debuggerPausedBreakpoint')
      case 'exception':
        return t('workbench.debuggerPausedException')
      case 'step':
        return t('workbench.debuggerPausedStep')
      case 'pause':
        return t('workbench.debuggerPausedPause')
      default:
        return t('workbench.debuggerPausedStatement')
    }
  }
  if (active) return t('workbench.debuggerRunning')
  if (!lastEnd) return t('workbench.debuggerIdle')

  switch (lastEnd.reason) {
    case 'failed':
      return t('workbench.debuggerEndedFailed', { message: lastEnd.message ?? '' })
    case 'exited':
      return t('workbench.debuggerEndedExited', { code: lastEnd.exitCode ?? '-' })
    default:
      return t('workbench.debuggerEndedStopped')
  }
}

function describeScope(t: Translate, scope: WorkbenchDebuggerScope): string {
  switch (scope.type) {
    case 'local':
      return t('workbench.debuggerScopeLocal')
    case 'block':
      return t('workbench.debuggerScopeBlock')
    case 'closure':
      return scope.name
        ? t('workbench.debuggerScopeClosureNamed', { name: scope.name })
        : t('workbench.debuggerScopeClosure')
    case 'module':
      return t('workbench.debuggerScopeModule')
    case 'script':
      return t('workbench.debuggerScopeScript')
    case 'global':
      return t('workbench.debuggerScopeGlobal')
    default:
      // catch / with / eval：就是语言里的那个词。
      return scope.type
  }
}

/** 值的那段文字：没有值可给的两种写成一句说明。 */
function describeValue(t: Translate, value: WorkbenchDebuggerValue): string {
  if (value.type === 'unavailable') return t('workbench.debuggerValueUnavailable')
  if (value.type === 'accessor') return t('workbench.debuggerValueAccessor')
  return value.text
}

/** 一个对象（或作用域）的属性：点开时才去取。 */
function DebugChildren({
  session,
  objectId,
  depth,
}: {
  session: WorkbenchDebugSessionController
  objectId: string
  depth: number
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [result, setResult] = useState<Nullable<WorkbenchDebuggerVariablesResult> | 'failed'>(null)

  useEffect(() => {
    let cancelled = false
    void session.getVariables(objectId).then((loaded) => {
      if (!cancelled) setResult(loaded ?? 'failed')
    })
    return () => {
      cancelled = true
    }
  }, [objectId, session])

  const note = (text: string): ReactElement => (
    <div className={styles.note} style={{ paddingLeft: 8 + depth * 14 }}>
      {text}
    </div>
  )
  if (result === null) return note(t('workbench.debuggerLoading'))
  if (result === 'failed') return note(t('workbench.debuggerValueGone'))
  if (result.variables.length === 0) return note(t('workbench.debuggerNoVariables'))

  return (
    <>
      {result.variables.map((variable, index) => (
        <DebugValueRow
          // 同名的属性（内部属性与自己的属性撞名）靠位置区分。
          key={`${index}:${variable.name}`}
          session={session}
          name={variable.name}
          value={variable.value}
          depth={depth}
          expandable
        />
      ))}
      {result.truncated &&
        note(t('workbench.debuggerVariablesTruncated', { count: result.variables.length }))}
    </>
  )
}

/** 一行「名字: 值」；值是对象时前面有个三角，点开看它的属性。 */
function DebugValueRow({
  session,
  name,
  value,
  depth,
  expandable,
}: {
  session: WorkbenchDebugSessionController
  name: string
  value: WorkbenchDebuggerValue
  depth: number
  /** 对象此刻还能不能展开（程序继续跑过之后就不能了）。 */
  expandable: boolean
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [open, setOpen] = useState(false)
  const objectId = expandable ? value.objectId : null
  const text = describeValue(t, value)

  return (
    <>
      <div
        className={styles.row}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-expandable={!!objectId}
        title={`${name}: ${text}`}
        onClick={objectId ? () => setOpen((current) => !current) : undefined}
      >
        <span className={styles.caret} aria-hidden="true">
          {objectId ? open ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} /> : null}
        </span>
        {!!name && <span className={styles.name}>{name}</span>}
        {!!name && <span className={styles.separator}>:</span>}
        <span className={styles.value} data-type={value.type}>
          {text}
        </span>
      </div>
      {open && objectId && (
        <DebugChildren session={session} objectId={objectId} depth={depth + 1} />
      )}
    </>
  )
}

/** 一个作用域：标题行加它的变量。最里面那个默认展开，其余（尤其是全局）点开才取。 */
function DebugScope({
  session,
  scope,
  defaultOpen,
}: {
  session: WorkbenchDebugSessionController
  scope: WorkbenchDebuggerScope
  defaultOpen: boolean
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [open, setOpen] = useState(defaultOpen)

  return (
    <>
      <div className={styles.scope} onClick={() => setOpen((current) => !current)}>
        <span className={styles.caret} aria-hidden="true">
          {open ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
        </span>
        {describeScope(t, scope)}
      </div>
      {open && <DebugChildren session={session} objectId={scope.objectId} depth={1} />}
    </>
  )
}

function DebugFrames({
  session,
  frames,
  selectedIndex,
}: {
  session: WorkbenchDebugSessionController
  frames: readonly WorkbenchDebuggerFrame[]
  selectedIndex: number
}): ReactElement {
  const { t } = useWorkbenchI18n()
  return (
    <>
      {frames.map((frame, index) => {
        const { location } = frame
        const place = `${fileNameOf(location.source)}:${location.line}`
        return (
          <button
            key={frame.id}
            type="button"
            className={styles.frame}
            data-active={index === selectedIndex}
            // 项目之外的（Node 自己的代码）没有可打开的文件：写淡一些，仍然可以选中看它的变量。
            data-external={location.path === null}
            title={`${location.source}:${location.line}:${location.column}`}
            onClick={() => session.selectFrame(index)}
          >
            <span className={styles.frameName}>
              {frame.functionName || t('workbench.debuggerAnonymousFunction')}
            </span>
            <span className={styles.framePlace}>{place}</span>
          </button>
        )
      })}
    </>
  )
}

/** 页面每次重画（编辑器里打一个字就有一次）不连带重画这里：它只跟着自己订阅的调试状态走。 */
export const WorkbenchDebugPanel = memo(function WorkbenchDebugPanel({
  projectRoot,
  shortcutHints,
  session = getWorkbenchDebugSession(),
}: WorkbenchDebugPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const readPauseOnExceptions = (): boolean => readWorkbenchExceptionPause(projectRoot)
  const pauseOnExceptions = useSyncExternalStore(
    subscribeWorkbenchBreakpoints,
    readPauseOnExceptions,
    readPauseOnExceptions
  )
  const [expression, setExpression] = useState('')
  const [evaluations, setEvaluations] = useState<EvaluationEntry[]>([])

  const { pause } = snapshot
  const active = !!snapshot.session
  const frame = pause?.frames[pause.selectedFrameIndex]

  const label = (action: WorkbenchDebugAction, text: string): string => {
    const hint = shortcutHints[action]
    return hint ? `${text} (${hint})` : text
  }
  const run = (action: WorkbenchDebugAction): void => session.runAction(action)

  function submitExpression(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = expression.trim()
    if (!text || !active) return

    const pauseSequence = pause?.sequence ?? null
    void session.evaluate(text).then((result) => {
      setEvaluations((current) =>
        [
          {
            id: (current[0]?.id ?? 0) + 1,
            expression: text,
            value: result.value,
            error: result.error,
            pauseSequence,
          },
          ...current,
        ].slice(0, MaxEvaluationEntries)
      )
    })
    setExpression('')
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        {pause || !active ? (
          <IconButton
            size="icon-sm"
            label={label('continue', t('workbench.debuggerContinue'))}
            disabled={!pause}
            onClick={() => run('continue')}
          >
            <PlayIcon size={14} weight="fill" />
          </IconButton>
        ) : (
          <IconButton
            size="icon-sm"
            label={label('pause', t('workbench.debuggerPause'))}
            onClick={() => run('pause')}
          >
            <PauseIcon size={14} weight="fill" />
          </IconButton>
        )}
        <IconButton
          size="icon-sm"
          label={label('step-over', t('workbench.debuggerStepOver'))}
          disabled={!pause}
          onClick={() => run('step-over')}
        >
          <ArrowArcRightIcon size={14} />
        </IconButton>
        <IconButton
          size="icon-sm"
          label={label('step-into', t('workbench.debuggerStepInto'))}
          disabled={!pause}
          onClick={() => run('step-into')}
        >
          <ArrowLineDownIcon size={14} />
        </IconButton>
        <IconButton
          size="icon-sm"
          label={label('step-out', t('workbench.debuggerStepOut'))}
          disabled={!pause}
          onClick={() => run('step-out')}
        >
          <ArrowLineUpIcon size={14} />
        </IconButton>
        <IconButton
          size="icon-sm"
          label={label('stop', t('workbench.debuggerStop'))}
          disabled={!active}
          onClick={() => run('stop')}
        >
          <StopIcon size={14} weight="fill" />
        </IconButton>
        <span className={styles.status} data-paused={!!pause}>
          {describeStatus(t, active, pause, snapshot.lastEnd)}
        </span>
        <label className={styles.exceptions}>
          <Checkbox
            size="sm"
            checked={pauseOnExceptions}
            onCheckedChange={(checked) => setWorkbenchExceptionPause(projectRoot, checked)}
          />
          {t('workbench.debuggerPauseOnUncaughtExceptions')}
        </label>
      </div>
      {pause?.exception && (
        <div className={styles.exception} title={pause.exception.text}>
          {pause.exception.text}
        </div>
      )}
      <div className={styles.columns}>
        <section className={styles.column} aria-label={t('workbench.debuggerCallStack')}>
          <div className={styles.columnTitle}>{t('workbench.debuggerCallStack')}</div>
          <div className={styles.columnBody}>
            {pause ? (
              <DebugFrames
                session={session}
                frames={pause.frames}
                selectedIndex={pause.selectedFrameIndex}
              />
            ) : (
              <div className={styles.empty}>
                {active ? t('workbench.debuggerRunningHint') : t('workbench.debuggerIdleHint')}
              </div>
            )}
          </div>
        </section>
        <section className={styles.column} aria-label={t('workbench.debuggerVariables')}>
          <div className={styles.columnTitle}>{t('workbench.debuggerVariables')}</div>
          {/* 换了一次停下、换了一帧：上一帧里点开的、取回来的都不算数了，整块重来。 */}
          <div className={styles.columnBody} key={`${pause?.sequence}:${pause?.selectedFrameIndex}`}>
            {frame?.scopes.map((scope, index) => (
              <DebugScope
                key={scope.objectId}
                session={session}
                scope={scope}
                defaultOpen={index === 0 && scope.type !== 'global'}
              />
            ))}
          </div>
        </section>
        <section className={styles.column} aria-label={t('workbench.debuggerEvaluate')}>
          <div className={styles.columnTitle}>{t('workbench.debuggerEvaluate')}</div>
          <form className={styles.expression} onSubmit={submitExpression}>
            <Input
              size="sm"
              className={styles.expressionInput}
              value={expression}
              disabled={!active}
              placeholder={t('workbench.debuggerExpressionPlaceholder')}
              spellCheck={false}
              onChange={(event) => setExpression(event.target.value)}
            />
          </form>
          <div className={styles.columnBody}>
            {evaluations.map((entry) => (
              <div key={entry.id} className={styles.evaluation}>
                <div className={styles.evaluationExpression} title={entry.expression}>
                  {entry.expression}
                </div>
                {entry.value ? (
                  <DebugValueRow
                    session={session}
                    name=""
                    value={entry.value}
                    depth={0}
                    expandable={entry.pauseSequence !== null && entry.pauseSequence === pause?.sequence}
                  />
                ) : (
                  <div className={styles.evaluationError}>{entry.error}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
})
