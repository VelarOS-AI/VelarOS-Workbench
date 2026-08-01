/**
 * 工作台终端「跟随真实目录」标记协议（照搬 desktop `workspace/workbench/terminalCwdMarker.ts`，
 * 保形零改动——纯字符串扫描，无外部依赖）。
 *
 * 终端子进程用管道 stdio（非 PTY、非交互），因此 zsh/bash 的 precmd/PROMPT_COMMAND
 * 钩子不会触发，前端也就拿不到 shell 真实的 `$PWD`。做法是：用户每提交一条命令后，
 * 追加一条探针命令，让 shell 把当前 `$PWD` 用一个 OSC 私有序列打到 stdout；主进程扫描
 * 该序列、抽出路径、并从要回传给渲染层的文本里剥掉它，从而在不污染可见输出的前提下
 * 让提示符跟随真实工作目录。
 */

/** OSC 私有序列前缀；697 取自常见 shell-integration 私有区，避免与用户输出撞车。 */
const MARKER_START = '\x1b]697;VELAROS_CWD='
/** OSC 终止符 BEL。 */
const MARKER_END = '\x07'

/**
 * 探针命令：把当前 `$PWD` 以 `MARKER_START<path>MARKER_END` 打到 stdout。
 *
 * 用八进制转义 `\033`/`\007`，zsh、bash、fish 的 printf 内建都能解析；作为独立的一行
 * 顶层命令执行，因此运行在主 shell 进程里，`$PWD` 反映用户 `cd` 之后的真实目录。
 */
export function buildTerminalCwdProbeCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // cmd.exe 没有 printf/$PWD；借助系统自带 PowerShell 继承 cmd 当前目录，并强制以 UTF-8
    // 输出 OSC 标记，避免中文 Windows 路径按活动代码页写出后被 Node 误解码。
    return '@powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write([char]27 + \']697;VELAROS_CWD=\' + (Get-Location).Path + [char]7)"\r\n'
  }

  return 'printf \'\\033]697;VELAROS_CWD=%s\\007\' "$PWD"\n'
}

export interface TerminalCwdScanResult {
  /** 剥掉所有完整标记、并暂存尾部半截标记之后，可安全回传渲染层的文本。 */
  text: string
  /** 本次缓冲区里解析到的最后一个 cwd；无则为 null。 */
  cwd: Nullable<string>
  /** 尾部可能是半截标记的部分，留到下个 chunk 拼接后再解析。 */
  carry: string
}

/**
 * 从 stdout 缓冲区里抽取 cwd 标记。
 *
 * - 完整标记（含 BEL）全部剥除，记录最后一个路径。
 * - 尾部若疑似半截标记（完整起始前缀无 BEL，或结尾是起始序列的某个前缀），
 *   整段留在 `carry`，等下个 chunk 拼上再解析，避免把标记字节泄漏到界面。
 */
export function scanTerminalCwdMarkers(buffer: string): TerminalCwdScanResult {
  // eslint-disable-next-line no-control-regex -- 标记以不可见控制字符 ESC/BEL 界定，正则必然含控制字符。
  const markerPattern = /\x1b\]697;VELAROS_CWD=([^\x07]*)\x07/g
  let cwd: Nullable<string> = null
  const stripped = buffer.replace(markerPattern, (_match, path: string) => {
    cwd = path
    return ''
  })

  const carryIndex = findPartialMarkerIndex(stripped)
  if (carryIndex >= 0)
    return { text: stripped.slice(0, carryIndex), cwd, carry: stripped.slice(carryIndex) }

  return { text: stripped, cwd, carry: '' }
}

/**
 * 找出尾部需要暂存的半截标记起点；没有则返回 -1。
 *
 * 完整标记已被剥除，所以任何残留的 `MARKER_START` 必然缺 BEL——直接从它起暂存。
 * 否则再看结尾是否命中 `MARKER_START` 的某个非空前缀（起始序列被 chunk 边界切开）。
 */
function findPartialMarkerIndex(stripped: string): number {
  const startIndex = stripped.indexOf(MARKER_START)
  if (startIndex >= 0) return startIndex

  const maxPrefix = Math.min(MARKER_START.length - 1, stripped.length)
  for (let length = maxPrefix; length >= 1; length--) {
    if (stripped.endsWith(MARKER_START.slice(0, length))) return stripped.length - length
  }

  return -1
}

export { MARKER_END as TERMINAL_CWD_MARKER_END, MARKER_START as TERMINAL_CWD_MARKER_START }
