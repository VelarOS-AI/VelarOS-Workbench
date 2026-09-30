/**
 * 把一个参数写进命令行。POSIX shell 用单引号包起来，里面的字符全都原样；Windows 的 cmd 用双引号，双引号里
 * 仍然特殊的 `"` 和 `%` 换成 `.`——这里引的是文件路径和正则，路径里极少有它们，正则里 `.` 正好匹配任意字符。
 *
 * 单独一个小模块：▶（在工作区外壳包里）和编辑器里的测试栏（按需加载）都要用。
 */
export function quoteWorkbenchShellArgument(value: string, windows: boolean): string {
  if (/^[\w./:=@-]+$/u.test(value)) return value
  if (windows) return `"${value.replace(/["%]/gu, '.')}"`
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** 此刻是不是跑在 Windows 上（命令行的引号写法不同）。 */
export function isWorkbenchWindowsHost(): boolean {
  return typeof navigator !== 'undefined' && /\bWindows\b/iu.test(navigator.userAgent)
}
