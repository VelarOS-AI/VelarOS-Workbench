/**
 * 文本文件在磁盘上的格式：main 与 renderer 共用的取值、校验与展示名。
 *
 * 编辑器正文一律不含 BOM、换行统一为 LF；读盘结果和保存请求带着 `encoding`（BOM 算编码的
 * 一部分）与 `eol`，保存时按它们写回，没编辑过的字节原样不动。编解码只在 main 侧
 * （`src/main/workspace/TextCodec.ts`）。
 */
export const WorkbenchTextEncodings = [
  'utf-8',
  'utf-8-bom',
  'utf-16le-bom',
  'utf-16be-bom',
  'utf-16le',
  'utf-16be',
  'gb18030',
] as const

/** 编码；`-bom` 结尾的写回时带 BOM。读盘只从 BOM 认 UTF-16，所以读到的 UTF-16 都带 BOM。 */
export type WorkbenchTextEncoding = (typeof WorkbenchTextEncodings)[number]

export const WorkbenchTextEols = ['lf', 'crlf', 'cr'] as const

/** 换行符：读盘取文件里占多数的一种，编辑器里一律是 LF，保存时换回这一种。 */
export type WorkbenchTextEol = (typeof WorkbenchTextEols)[number]

/** 一段文本写回磁盘的格式。 */
export interface WorkbenchTextFormat {
  encoding: WorkbenchTextEncoding
  eol: WorkbenchTextEol
}

/**
 * 磁盘字节不能按读到的格式逐字节写回的原因。有值时编辑器只读打开，用户明确转换后才重写：
 * - `undecodable`：不是 UTF-8 / UTF-16 / GB18030 能严格解出的字节，正文里是替换字符；
 * - `irreversible`：能解码，但按同一编码写回得不到原来的字节（如 GB18030 的四字节序列）；
 * - `mixed-eol`：混用了多种换行符，保存会把它们统一成占多数的一种。
 */
export type WorkbenchTextIssue = 'undecodable' | 'irreversible' | 'mixed-eol'

/** 新文件、以及保存请求没带格式又没有磁盘文件可参照时用的格式。 */
export const DefaultWorkbenchTextFormat: Readonly<WorkbenchTextFormat> = {
  encoding: 'utf-8',
  eol: 'lf',
}

/**
 * 保存被拒绝的错误码（IPC 错误信封里的 `code`）：内容里有目标编码写不出的字符，
 * 这次没有写盘。renderer 据此提示并提供「转换为 UTF-8」。
 */
export const WorkbenchUnencodableTextErrorCode = 'UNENCODABLE_TEXT'

const EncodingLabels: Readonly<Record<WorkbenchTextEncoding, string>> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'utf-16le-bom': 'UTF-16 LE BOM',
  'utf-16be-bom': 'UTF-16 BE BOM',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  gb18030: 'GB18030',
}

const EolLabels: Readonly<Record<WorkbenchTextEol, string>> = {
  lf: 'LF',
  crlf: 'CRLF',
  cr: 'CR',
}

export function isWorkbenchTextEncoding(value: unknown): value is WorkbenchTextEncoding {
  return typeof value === 'string' && WorkbenchTextEncodings.includes(
    value as WorkbenchTextEncoding
  )
}

export function isWorkbenchTextEol(value: unknown): value is WorkbenchTextEol {
  return typeof value === 'string' && WorkbenchTextEols.includes(value as WorkbenchTextEol)
}

/** 状态栏等处显示的编码名，如 `UTF-8`、`GB18030`、`UTF-16 LE BOM`。 */
export function formatWorkbenchTextEncoding(encoding: WorkbenchTextEncoding): string {
  return EncodingLabels[encoding]
}

/** 换行符的显示名：`LF` / `CRLF` / `CR`。 */
export function formatWorkbenchTextEol(eol: WorkbenchTextEol): string {
  return EolLabels[eol]
}

/** 与 CodeMirror 一致：`\r\n`、单独的 `\r` 都算一次换行，统一成 `\n`。 */
export function normalizeWorkbenchTextEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/gu, '\n') : text
}
