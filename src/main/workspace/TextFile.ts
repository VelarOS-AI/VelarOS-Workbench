import { type FileHandle, open, stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/velaros/core/error'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

import {
  countWorkbenchTextLines,
  type DecodedWorkbenchText,
  decodeWorkbenchText,
  detectWorkbenchTextBom,
} from './TextCodec'

/**
 * 读到的文本文件：正文已去掉 BOM、换行统一为 LF，超过 maxChars 的部分截掉（截断的只读）。
 * 截断时 `totalLines` 只数读到的这一段。
 */
interface WorkbenchTextFileSnapshot extends DecodedWorkbenchText {
  size: number
  modifiedAt: number
  totalLines: number
  truncated: boolean
}

const TextProbeSampleBytes = 4096
const TextProbeSuspiciousRatio = 0.08
/**
 * 一个正文字符最多占这么多字节：GB18030 的四字节字符、UTF-16 的 CRLF（换行统一后算一个字符）。
 * 文件比 maxChars × 4 还大时正文一定超过 maxChars，只读开头这么多字节就够截断视图用。
 */
const MaxBytesPerChar = 4
const BomAndSplitCharBytes = 8

/**
 * 文本似然门（照搬 desktop `workspace/workbench/TextFile.ts`）：NUL 立拒 + 控制字节占比 <8%。
 * 带 BOM 的 UTF-16 按 16 位码元判断——它的 ASCII 字符本来就带一个 0 字节。
 */
function isLikelyTextFile(buffer: Uint8Array): boolean {
  if (buffer.length === 0) return true

  const bom = detectWorkbenchTextBom(buffer)
  if (bom?.encoding === 'utf-16le-bom' || bom?.encoding === 'utf-16be-bom') {
    const sample = buffer.subarray(bom.length, bom.length + TextProbeSampleBytes)
    return isLikelyUtf16Text(sample, bom.encoding === 'utf-16le-bom')
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, TextProbeSampleBytes))
  if (sample.includes(0)) return false

  let suspicious = 0
  for (const byte of sample) {
    if (isSuspiciousControl(byte)) suspicious += 1
  }

  return suspicious / sample.length < TextProbeSuspiciousRatio
}

function isLikelyUtf16Text(sample: Uint8Array, littleEndian: boolean): boolean {
  const units = Math.floor(sample.length / 2)
  if (units === 0) return true

  let suspicious = 0
  for (let index = 0; index < units; index += 1) {
    const low = sample[index * 2 + (littleEndian ? 0 : 1)]
    const high = sample[index * 2 + (littleEndian ? 1 : 0)]
    const unit = (high << 8) | low
    if (unit === 0) return false
    if (isSuspiciousControl(unit)) suspicious += 1
  }

  return suspicious / units < TextProbeSuspiciousRatio
}

function isSuspiciousControl(code: number): boolean {
  return code < 32 && code !== 9 && code !== 10 && code !== 13
}

/**
 * 读项目里的一个文本文件：认出编码与换行符，完整读到的还要核对能否原样写回。先看体积，
 * 大文件只读截断视图用得到的开头一段，不把整个文件读进内存再切。
 */
async function readWorkbenchTextFile(
  path: string,
  maxChars: number
): Promise<WorkbenchTextFileSnapshot> {
  const fileStats = await stat(path)
  if (!fileStats.isFile()) {
    throw new AppError('VALIDATION', workbenchMainText('files.readTargetNotFile'))
  }

  const byteLimit = maxChars * MaxBytesPerChar + BomAndSplitCharBytes
  const handle = await open(path, 'r')
  let head: Buffer
  try {
    head = await readHead(handle, Math.min(fileStats.size, byteLimit))
  } finally {
    await handle.close()
  }
  if (!isLikelyTextFile(head)) {
    throw new AppError('VALIDATION', workbenchMainText('files.notPreviewableText'))
  }

  const complete = fileStats.size <= byteLimit
  const decoded = decodeWorkbenchText(head, complete)
  const truncated = !complete || decoded.content.length > maxChars
  const content = truncated ? cutAtCharBoundary(decoded.content, maxChars) : decoded.content
  return {
    ...decoded,
    content,
    size: fileStats.size,
    modifiedAt: fileStats.mtimeMs,
    totalLines: countWorkbenchTextLines(content),
    truncated,
  }
}

async function readHead(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

/** 截到 maxChars，不把代理对切成半个。 */
function cutAtCharBoundary(content: string, maxChars: number): string {
  const end = Math.min(content.length, maxChars)
  const last = content.charCodeAt(end - 1)
  return content.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

export { isLikelyTextFile, isLikelyTextFile as isLikelyWorkbenchTextFile, readWorkbenchTextFile }
export type { WorkbenchTextFileSnapshot }
