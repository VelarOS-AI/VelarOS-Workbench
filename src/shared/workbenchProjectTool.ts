import type { WorkbenchProjectToolTarget } from './contracts/workbench'

/** Maven 和 Gradle 在 Windows 上可能通过批处理启动，只接受不含 shell 元字符的任务参数。 */
export function readWorkbenchProjectToolTarget(value: {
  program?: unknown
  argv?: unknown
}): WorkbenchProjectToolTarget | null {
  const { program, argv } = value
  if (program !== 'dotnet' && program !== 'mvn' && program !== 'gradle') return null
  if (!Array.isArray(argv) || !argv.length) return null
  const safeArgument = program === 'dotnet' ? /^[^\0]+$/u : /^[\w.$:=/-]+$/u
  const arguments_: string[] = []
  for (const argument of argv as unknown[]) {
    if (typeof argument !== 'string' || !safeArgument.test(argument)) return null
    arguments_.push(argument)
  }
  return { kind: 'project-tool', program, argv: arguments_ }
}
