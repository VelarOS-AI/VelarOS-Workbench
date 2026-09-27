import type { WorkbenchReadFileResult } from '@shared/contracts'
import type { WorkbenchTextFormat, WorkbenchTextIssue } from '@shared/workbenchTextFormat'

import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

/**
 * 编辑器标签的文本格式（编码、BOM、换行符）纯逻辑。
 *
 * 标签里的正文一律去掉 BOM、换行统一为 LF；`tab.file` 记着磁盘上的格式，保存时按它原样写回。
 * 用户明确选了转换（转换为 UTF-8、换换行符）才记到 `tab.textConversion`，保存成功前都算未保存。
 */

type WorkbenchFileTextFormat = Pick<WorkbenchReadFileResult, 'encoding' | 'eol' | 'textIssue'>

/** 保存这个标签时写回的格式：选过转换就按转换，否则按磁盘上的原样写回。 */
export function resolveWorkbenchTabTextFormat(tab: {
  file: WorkbenchFileTextFormat
  textConversion?: WorkbenchTextFormat
}): WorkbenchTextFormat {
  return tab.textConversion ?? { encoding: tab.file.encoding, eol: tab.file.eol }
}

/**
 * 用户选定一种格式后标签上要记的转换：与磁盘上的格式一样、文件又能原样写回时不需要转换
 * （返回 undefined）；否则就是这次转换，存下去会重写文件。
 */
export function resolveWorkbenchTextConversion(
  file: WorkbenchFileTextFormat,
  format: WorkbenchTextFormat
): WorkbenchTextFormat | undefined {
  const unchanged = !file.textIssue && file.encoding === format.encoding && file.eol === format.eol
  return unchanged ? undefined : { encoding: format.encoding, eol: format.eol }
}

/** 编码认不出、或解得出却写不回原字节：只有转换为 UTF-8 能解决，换换行符不行。 */
export function hasWorkbenchEncodingIssue(
  file: Pick<WorkbenchReadFileResult, 'textIssue'>
): boolean {
  return file.textIssue === 'undecodable' || file.textIssue === 'irreversible'
}

/**
 * 编辑区提示条：当前文件为什么只读（或者为什么没存下去），以及用户可以明确选择的出路。
 * - `undecodable` / `irreversible` / `unencodable`：只能转换为 UTF-8（先确认，确认后立即保存）；
 * - `mixed-eol`：统一成占多数的换行符。
 * 截断的文件、图片没有完整文本，转换不了，不提示；已经选了转换的等保存结果。
 */
export interface WorkbenchTextFormatNotice extends WorkbenchTextFormat {
  kind: WorkbenchTextIssue | 'unencodable'
  /** `unencodable`：主进程拒绝保存的说明（哪一行哪个字符写不出）。 */
  message?: string
}

export function resolveWorkbenchTextFormatNotice(
  tab: Pick<WorkbenchOpenEditorTab, 'file' | 'textConversion' | 'unencodableSaveError'>
): Nullable<WorkbenchTextFormatNotice> {
  const { file } = tab
  if (file.imagePreview || file.truncated || tab.textConversion) return null

  const format = { encoding: file.encoding, eol: file.eol }
  if (tab.unencodableSaveError)
    return { kind: 'unencodable', ...format, message: tab.unencodableSaveError }
  if (!file.textIssue) return null

  return { kind: file.textIssue, ...format }
}
