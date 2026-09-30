/**
 * 「编辑运行配置」对话框里正在改的草稿：字段原样是输入框里的字，环境变量是一段「KEY=VALUE，一行一个」的文本。
 * 草稿与存着的配置互相转换、校验、起不重名的名字都在这里。只有对话框用——对话框按需加载，这些不进工作区外壳包
 * （外壳只要读配置、跑配置，见 `workbenchNamedRunConfigurations.ts`）。
 */
import {
  isWorkbenchEnvironmentVariableName,
  isWorkbenchEnvironmentVariableValue,
  type WorkbenchRunEnvironment,
  WorkbenchRunEnvironmentMaxVariables,
} from '@shared/workbenchRunEnvironment'

import {
  normalizeWorkbenchNamedRunConfiguration,
  normalizeWorkbenchRunConfigurationCwd,
  type WorkbenchNamedRunConfiguration,
  WorkbenchRunConfigurationNameMaxLength,
  type WorkbenchRunConfigurationType,
} from './workbenchNamedRunConfigurations'

export interface WorkbenchRunConfigurationDraft {
  id: string
  name: string
  type: WorkbenchRunConfigurationType
  /** 命令型用的；换成 Node 程序时输入框里的字留着，换回来还在，存的时候才丢。 */
  command: string
  /** Node 程序用的：脚本与参数。 */
  script: string
  args: string
  cwd: string
  envText: string
}

/** 「KEY=VALUE，一行一个」里没读懂的一行。 */
export interface WorkbenchRunEnvironmentTextIssue {
  /** 第几行（从 1 起）。 */
  line: number
  text: string
  reason: 'missing-equals' | 'invalid-name' | 'invalid-value' | 'too-many'
}

export interface WorkbenchRunConfigurationDraftIssues {
  name?: 'required'
  command?: 'required'
  /** Node 程序的脚本：没填，或者写成了绝对路径、带着 `..` 要往项目外面走。 */
  script?: 'required' | 'outside-project'
  /** 工作目录写成了绝对路径，或者带着 `..` 要往项目外面走。 */
  cwd?: 'outside-project'
  env?: WorkbenchRunEnvironmentTextIssue[]
}

/**
 * 读「KEY=VALUE，一行一个」的文本。空行和 `#` 开头的行跳过；名字两边的空白去掉，第一个 `=` 之后整段原样当值
 * （不解析引号，不展开 `$VAR`——写什么进程就拿到什么）。同名的后一行盖掉前一行。
 */
export function parseWorkbenchRunEnvironmentText(text: string): {
  environment: WorkbenchRunEnvironment
  issues: WorkbenchRunEnvironmentTextIssue[]
} {
  const environment: WorkbenchRunEnvironment = {}
  const issues: WorkbenchRunEnvironmentTextIssue[] = []

  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    const reason = readEnvironmentLine(line, environment)
    if (reason) issues.push({ line: index + 1, text: line, reason })
  }

  return { environment, issues }
}

/** 读一行进 `environment`；读不懂就返回原因。 */
function readEnvironmentLine(
  line: string,
  environment: WorkbenchRunEnvironment
): Nullable<WorkbenchRunEnvironmentTextIssue['reason']> {
  const separator = line.indexOf('=')
  if (separator === -1) return 'missing-equals'

  const name = line.slice(0, separator).trim()
  const value = line.slice(separator + 1)
  if (!isWorkbenchEnvironmentVariableName(name)) return 'invalid-name'
  if (!isWorkbenchEnvironmentVariableValue(value)) return 'invalid-value'
  if (
    !Object.hasOwn(environment, name) &&
    Object.keys(environment).length >= WorkbenchRunEnvironmentMaxVariables
  )
    return 'too-many'

  environment[name] = value
  return null
}

/** 环境变量表写回「KEY=VALUE，一行一个」的文本。 */
export function formatWorkbenchRunEnvironmentText(environment: WorkbenchRunEnvironment): string {
  return Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')
}

export function createWorkbenchRunConfigurationId(): string {
  return `run-configuration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** `base`，被占了就 `base 2`、`base 3`……（不分大小写地比）。 */
export function uniqueWorkbenchRunConfigurationName(
  base: string,
  takenNames: readonly string[]
): string {
  const taken = new Set(takenNames.map((name) => name.trim().toLowerCase()))
  // 给后面的序号留出位置，不让加了序号的名字超长。
  const trimmedBase = base.trim().slice(0, WorkbenchRunConfigurationNameMaxLength - 4)
  if (!taken.has(trimmedBase.toLowerCase())) return trimmedBase

  for (let index = 2; ; index += 1) {
    const candidate = `${trimmedBase} ${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function toWorkbenchRunConfigurationDraft(
  configuration: WorkbenchNamedRunConfiguration
): WorkbenchRunConfigurationDraft {
  return {
    id: configuration.id,
    name: configuration.name,
    type: configuration.type,
    command: configuration.command,
    script: configuration.script,
    args: configuration.args,
    cwd: configuration.cwd,
    envText: formatWorkbenchRunEnvironmentText(configuration.env),
  }
}

export function createWorkbenchRunConfigurationDraft(name: string): WorkbenchRunConfigurationDraft {
  return {
    id: createWorkbenchRunConfigurationId(),
    name,
    type: 'command',
    command: '',
    script: '',
    args: '',
    cwd: '',
    envText: '',
  }
}

/** 复制一份：字段照搬，换一个新 id 和不重名的名字。 */
export function duplicateWorkbenchRunConfigurationDraft(
  draft: WorkbenchRunConfigurationDraft,
  name: string
): WorkbenchRunConfigurationDraft {
  return { ...draft, id: createWorkbenchRunConfigurationId(), name }
}

/** 这份草稿哪里还不能存；都没问题返回 null。 */
export function validateWorkbenchRunConfigurationDraft(
  draft: WorkbenchRunConfigurationDraft
): Nullable<WorkbenchRunConfigurationDraftIssues> {
  const issues: WorkbenchRunConfigurationDraftIssues = {}
  if (!draft.name.trim()) issues.name = 'required'
  if (draft.type === 'node') {
    const script = normalizeWorkbenchRunConfigurationCwd(draft.script)
    if (script === null) issues.script = 'outside-project'
    else if (!script) issues.script = 'required'
  } else if (!draft.command.trim()) issues.command = 'required'
  if (normalizeWorkbenchRunConfigurationCwd(draft.cwd) === null) issues.cwd = 'outside-project'
  const environment = parseWorkbenchRunEnvironmentText(draft.envText)
  if (environment.issues.length > 0) issues.env = environment.issues

  return Object.keys(issues).length > 0 ? issues : null
}

/** 草稿存成配置；草稿还有问题（见 {@link validateWorkbenchRunConfigurationDraft}）时返回 null。 */
export function buildWorkbenchRunConfigurationFromDraft(
  draft: WorkbenchRunConfigurationDraft
): Nullable<WorkbenchNamedRunConfiguration> {
  if (validateWorkbenchRunConfigurationDraft(draft)) return null

  return normalizeWorkbenchNamedRunConfiguration({
    id: draft.id,
    name: draft.name.trim().slice(0, WorkbenchRunConfigurationNameMaxLength),
    type: draft.type,
    command: draft.command,
    script: draft.script,
    args: draft.args,
    cwd: draft.cwd,
    env: parseWorkbenchRunEnvironmentText(draft.envText).environment,
  })
}
