/**
 * 运行配置给进程加的环境变量：renderer 存、改、校验，main 在起伪终端前再校验一遍（IPC 入参是边界外来数据）。
 * 两边认的是同一条规则，所以放在 shared。
 *
 * 这不是密钥管理：值明文存在应用自己的存储里，界面上也原样显示。日志里不写值。
 */

/** 变量名：字母或下划线开头，后面是字母、数字、下划线（shell 与 dotenv 都认的那种）。 */
const EnvironmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u
/** 一份配置最多带这么多个变量；再多多半是贴错了东西。 */
export const WorkbenchRunEnvironmentMaxVariables = 256
const MaxVariableNameLength = 256
/** 单个值的长度上限（Windows 单个环境变量的上限是 32,767 个字符）。 */
const MaxVariableValueLength = 32_767

export type WorkbenchRunEnvironment = Record<string, string>

export function isWorkbenchEnvironmentVariableName(name: string): boolean {
  return (
    name.length <= MaxVariableNameLength &&
    EnvironmentVariableNamePattern.test(name) &&
    // 往普通对象上写这个键是在改原型，变量会悄悄丢掉。
    name !== '__proto__'
  )
}

export function isWorkbenchEnvironmentVariableValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MaxVariableValueLength && !value.includes('\0')
}

/**
 * 把外来数据读成环境变量表：每一项都得是「合法的名字 → 不含 NUL 的字符串」，有一项不对、或者项数超了上限，
 * 整份就不算数（返回 null）。不给（undefined / null）算空表。
 */
export function readWorkbenchRunEnvironment(value: unknown): Nullable<WorkbenchRunEnvironment> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > WorkbenchRunEnvironmentMaxVariables) return null

  const environment: WorkbenchRunEnvironment = {}
  for (const [name, variableValue] of entries) {
    if (!isWorkbenchEnvironmentVariableName(name)) return null
    if (!isWorkbenchEnvironmentVariableValue(variableValue)) return null
    environment[name] = variableValue
  }
  return environment
}
