/** 为 node-pty 保留 argv 边界；Windows 的整段 Shell 脚本不能被误当成预先加引号的参数。 */
export function buildPtyArguments(
  args: string[],
  windowsVerbatimArguments?: boolean,
  platform: NodeJS.Platform = process.platform
): string | string[] {
  if (platform !== 'win32') return args
  if (windowsVerbatimArguments) return args.join(' ')
  return args.map(quoteWindowsArgument).join(' ')
}

/** 使用 CRT 规则处理嵌入引号及末尾反斜杠；始终包外层，不猜输入是否已被 Shell 引用。 */
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}
