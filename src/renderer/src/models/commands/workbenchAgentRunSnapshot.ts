import type { WorkbenchAgentRunSnapshot } from '@shared/workbenchAgentUi'

import type { WorkbenchTerminalSessionView } from './workbenchCommandLines'

// CSI（颜色、光标移动、清行）与 OSC（窗口标题、超链接）两类控制序列；零散的 ESC 一并去掉。
// eslint-disable-next-line no-control-regex -- 终端控制序列以 ESC/BEL 界定，正则必然含控制字符。
const CsiSequencePattern = /\u001b\[[0-?]*[ -/]*[@-~]/gu
// eslint-disable-next-line no-control-regex -- 终端控制序列以 ESC/BEL 界定，正则必然含控制字符。
const OscSequencePattern = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu
// eslint-disable-next-line no-control-regex -- 终端控制序列以 ESC/BEL 界定，正则必然含控制字符。
const StrayEscapePattern = /\u001b[@-_]?/gu

/**
 * 把终端输出变成给模型读的纯文本：去掉颜色等控制序列；进度条那种用回车反复重写的行只留最后一次。
 */
export function stripWorkbenchTerminalControlSequences(text: string): string {
  return text
    .replace(OscSequencePattern, '')
    .replace(CsiSequencePattern, '')
    .replace(StrayEscapePattern, '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
}

/**
 * `workbench:read_run` 的回执：一条运行最近 `lines` 行输出。面板只保留最近的一段输出块，
 * `totalLines` 是这一段里的行数；`match` 在这整段里找（不分大小写）。
 */
export function buildWorkbenchAgentRunSnapshot(
  session: WorkbenchTerminalSessionView,
  lines: number,
  match: string | null
): WorkbenchAgentRunSnapshot {
  const text = stripWorkbenchTerminalControlSequences(
    session.lines.map((line) => line.text).join('')
  )
  const allLines = text.split('\n')
  if (allLines.at(-1) === '') allLines.pop()
  return {
    sessionId: session.id,
    command: session.command ?? session.title,
    running: session.isRunning,
    output: allLines.slice(-Math.max(1, lines)).join('\n'),
    totalLines: allLines.length,
    ...(match ? { matched: text.toLowerCase().includes(match.toLowerCase()) } : {}),
  }
}
