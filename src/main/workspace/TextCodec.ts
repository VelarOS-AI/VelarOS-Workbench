/**
 * 工作台文本编解码：读盘认出编码、BOM 与换行符，写盘按同一格式写回。
 *
 * 原则是不改用户没编辑过的字节：文件字节要能按认出的编码、BOM 与换行符逐字节还原，编辑器
 * 才允许修改；否则带着原因（`textIssue`）只读打开，等用户明确转换后才重写整份文件。
 *
 * - 认编码：UTF-8 BOM → UTF-16 LE / BE BOM → 严格 UTF-8 → 严格 GB18030 → 都不是（按 UTF-8
 *   显示替换字符，只读）。
 * - 写编码：UTF-8 / UTF-16 走 Buffer；GB18030 由 TextDecoder 反解全部双字节序列懒建编码表
 *   （外加 ASCII），表外的字符（四字节区、不成对的代理项）拒绝保存，绝不写有损字节。
 * - 换行：统计 CRLF / LF / CR 取占多数的一种（一样多时依次取 LF、CRLF），正文统一成 LF，
 *   保存时换回；混用多种的文件保存会把它们统一成这一种，所以同样只读，等用户选定换行符。
 */
import { AppError } from '@velaros-ai/core/error'

import {
  formatWorkbenchTextEncoding,
  normalizeWorkbenchTextEol,
  type WorkbenchTextEncoding,
  type WorkbenchTextEol,
  type WorkbenchTextFormat,
  type WorkbenchTextIssue,
  WorkbenchUnencodableTextErrorCode,
} from '@shared/workbenchTextFormat'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

interface DecodedWorkbenchText {
  /** 去掉 BOM、换行统一为 LF 的正文。 */
  content: string
  encoding: WorkbenchTextEncoding
  /** 占多数的换行符；没有换行的文件记为 LF。 */
  eol: WorkbenchTextEol
  textIssue?: WorkbenchTextIssue
}

interface WorkbenchTextBom {
  encoding: 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom'
  length: number
}

interface EolCounts {
  lf: number
  crlf: number
  cr: number
}

interface DetectedText {
  text: string
  encoding: WorkbenchTextEncoding
  undecodable: boolean
}

const Utf8Bom = Buffer.from([0xef, 0xbb, 0xbf])
const Utf16LeBom = Buffer.from([0xff, 0xfe])
const Utf16BeBom = Buffer.from([0xfe, 0xff])

const DecoderLabels: Readonly<Record<WorkbenchTextEncoding, string>> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  'utf-16le-bom': 'utf-16le',
  'utf-16be-bom': 'utf-16be',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  gb18030: 'gb18030',
}

const EolSequences: Readonly<Record<WorkbenchTextEol, string>> = {
  lf: '\n',
  crlf: '\r\n',
  cr: '\r',
}

let gb18030EncodeTable: Nullable<Uint16Array> = null

/** 文件开头的 BOM；没有时返回 null。 */
function detectWorkbenchTextBom(bytes: Uint8Array): Nullable<WorkbenchTextBom> {
  if (startsWith(bytes, Utf8Bom)) return { encoding: 'utf-8-bom', length: Utf8Bom.length }
  if (startsWith(bytes, Utf16LeBom)) return { encoding: 'utf-16le-bom', length: Utf16LeBom.length }
  if (startsWith(bytes, Utf16BeBom)) return { encoding: 'utf-16be-bom', length: Utf16BeBom.length }
  return null
}

/**
 * 解码读到的字节，认出编码与换行符，并核对能否原样写回。
 *
 * `complete` 为 false 表示只读了文件开头一段（截断视图）：末尾可能切在多字节字符中间，
 * 按流式解码略过；这时也没法核对整份文件能否原样写回（截断的文件本来就只读）。
 */
function decodeWorkbenchText(bytes: Uint8Array, complete = true): DecodedWorkbenchText {
  const detected = detectAndDecode(bytes, complete)
  // 只读到开头一段时，末尾的 \r 可能是被切开的 CRLF 的前半：不算它，免得误判成混用换行。
  const text =
    !complete && detected.text.endsWith('\r') ? detected.text.slice(0, -1) : detected.text
  const eols = countEols(text)

  return {
    content: normalizeWorkbenchTextEol(text),
    encoding: detected.encoding,
    eol: dominantEol(eols),
    textIssue: resolveTextIssue(bytes, detected, eols, complete),
  }
}

/** 只要正文（搜索、索引用）：同样认编码、去 BOM、统一换行，不核对能否写回。 */
function decodeWorkbenchTextContent(bytes: Uint8Array): string {
  return normalizeWorkbenchTextEol(detectAndDecode(bytes, true).text)
}

/**
 * 按格式编码要写盘的正文：正文里的 `\r\n` / `\r` / `\n` 都按一次换行处理，换成 `eol`。
 * 目标编码写不出某个字符时抛错（带行列号），绝不写有损字节。
 */
function encodeWorkbenchText(content: string, format: WorkbenchTextFormat): Buffer {
  const text = normalizeWorkbenchTextEol(content)
  const unencodableIndex = findUnencodableIndex(text, format.encoding)
  if (unencodableIndex >= 0)
    throw createUnencodableTextError(text, unencodableIndex, format.encoding)

  return encodeEncodableText(
    format.eol === 'lf' ? text : text.replaceAll('\n', EolSequences[format.eol]),
    format.encoding
  )
}

/** LF 正文的行数（空文本算一行），不切分数组。 */
function countWorkbenchTextLines(content: string): number {
  let lines = 1
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1))
    lines += 1
  return lines
}

function detectAndDecode(bytes: Uint8Array, complete: boolean): DetectedText {
  const bom = detectWorkbenchTextBom(bytes)
  if (bom) {
    const body = bytes.subarray(bom.length)
    const text = decodeStrictly(bom.encoding, body, complete)
    if (text !== null) return { text, encoding: bom.encoding, undecodable: false }

    const lossy = decodeLossily(bom.encoding, body, complete)
    return { text: lossy, encoding: bom.encoding, undecodable: true }
  }

  const utf8 = decodeStrictly('utf-8', bytes, complete)
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', undecodable: false }

  const gb18030 = decodeStrictly('gb18030', bytes, complete)
  if (gb18030 !== null) return { text: gb18030, encoding: 'gb18030', undecodable: false }

  return { text: decodeLossily('utf-8', bytes, complete), encoding: 'utf-8', undecodable: true }
}

function resolveTextIssue(
  bytes: Uint8Array,
  detected: DetectedText,
  eols: EolCounts,
  complete: boolean
): WorkbenchTextIssue | undefined {
  if (detected.undecodable) return 'undecodable'
  if (complete && !roundTripsExactly(bytes, detected.text, detected.encoding)) return 'irreversible'
  if ([eols.lf, eols.crlf, eols.cr].filter((count) => count > 0).length > 1) return 'mixed-eol'
  return undefined
}

function decodeStrictly(
  encoding: WorkbenchTextEncoding,
  bytes: Uint8Array,
  complete: boolean
): Nullable<string> {
  try {
    return new TextDecoder(DecoderLabels[encoding], { fatal: true, ignoreBOM: true }).decode(
      bytes,
      { stream: !complete }
    )
  } catch {
    return null
  }
}

function decodeLossily(
  encoding: WorkbenchTextEncoding,
  bytes: Uint8Array,
  complete: boolean
): string {
  return new TextDecoder(DecoderLabels[encoding], { ignoreBOM: true }).decode(bytes, {
    stream: !complete,
  })
}

/** 解出的正文（原样的换行）按同一编码写回，是否与读到的字节完全一致。 */
function roundTripsExactly(
  bytes: Uint8Array,
  text: string,
  encoding: WorkbenchTextEncoding
): boolean {
  if (findUnencodableIndex(text, encoding) >= 0) return false

  return Buffer.compare(encodeEncodableText(text, encoding), bytes) === 0
}

function countEols(text: string): EolCounts {
  const counts: EolCounts = { lf: 0, crlf: 0, cr: 0 }
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 0x0d) counts.crlf += 1
    else counts.lf += 1
  }
  for (let index = text.indexOf('\r'); index !== -1; index = text.indexOf('\r', index + 1)) {
    if (text.charCodeAt(index + 1) !== 0x0a) counts.cr += 1
  }
  return counts
}

function dominantEol({ lf, crlf, cr }: EolCounts): WorkbenchTextEol {
  if (lf >= crlf && lf >= cr) return 'lf'
  return crlf >= cr ? 'crlf' : 'cr'
}

/** 第一个目标编码写不出的字符的位置；都写得出时返回 -1。 */
function findUnencodableIndex(text: string, encoding: WorkbenchTextEncoding): number {
  if (encoding !== 'gb18030') return findLoneSurrogateIndex(text)

  const table = getGb18030EncodeTable()
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x80 && table[code] === 0) return index
  }
  return -1
}

/** UTF-8 / UTF-16 写得出所有字符，唯独不成对的代理项（Buffer 会悄悄换成 U+FFFD）。 */
function findLoneSurrogateIndex(text: string): number {
  if (text.isWellFormed()) return -1

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0xd800 || code > 0xdfff) continue

    // 末尾越界时 next 是 NaN，比较一律为假：只能正着判断「是一对」。
    const next = text.charCodeAt(index + 1)
    const isPair = code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    if (!isPair) return index
    index += 1
  }
  return -1
}

/** 调用方已确认每个字符都写得出（findUnencodableIndex 返回 -1）。 */
function encodeEncodableText(text: string, encoding: WorkbenchTextEncoding): Buffer {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf8')
    case 'utf-8-bom':
      return Buffer.concat([Utf8Bom, Buffer.from(text, 'utf8')])
    case 'utf-16le':
      return Buffer.from(text, 'utf16le')
    case 'utf-16le-bom':
      return Buffer.concat([Utf16LeBom, Buffer.from(text, 'utf16le')])
    case 'utf-16be':
      return Buffer.from(text, 'utf16le').swap16()
    case 'utf-16be-bom':
      return Buffer.concat([Utf16BeBom, Buffer.from(text, 'utf16le').swap16()])
    case 'gb18030':
      return encodeGb18030(text)
  }
}

function encodeGb18030(text: string): Buffer {
  const table = getGb18030EncodeTable()
  const bytes = Buffer.allocUnsafe(text.length * 2)
  let length = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes[length] = code
      length += 1
      continue
    }

    const pair = table[code]
    bytes[length] = pair >> 8
    bytes[length + 1] = pair & 0xff
    length += 2
  }
  return bytes.subarray(0, length)
}

/**
 * 字符（UTF-16 码元）→ GB18030 双字节，0 表示表里没有。首次用到时用 TextDecoder 反解全部
 * 双字节序列（首字节 0x81–0xFE，尾字节 0x40–0x7E、0x80–0xFE）建表，约 2.4 万项。
 * 同一个字符有两种写法时（如 U+3000 的 A1A1 与 A3A0）取先出现的一种；用另一种写的文件
 * 过不了逐字节还原的核对，只读打开。
 */
function getGb18030EncodeTable(): Uint16Array {
  if (gb18030EncodeTable) return gb18030EncodeTable

  const table = new Uint16Array(0x10000)
  const decoder = new TextDecoder('gb18030', { fatal: true })
  const pair = new Uint8Array(2)
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    pair[0] = lead
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue

      pair[1] = trail
      const char = decodeGb18030Pair(decoder, pair)
      if (char?.length !== 1) continue

      const code = char.charCodeAt(0)
      if (code >= 0x80 && table[code] === 0) table[code] = (lead << 8) | trail
    }
  }
  gb18030EncodeTable = table
  return table
}

function decodeGb18030Pair(decoder: TextDecoder, pair: Uint8Array): Nullable<string> {
  try {
    return decoder.decode(pair)
  } catch {
    return null
  }
}

function createUnencodableTextError(
  text: string,
  index: number,
  encoding: WorkbenchTextEncoding
): AppError {
  const { line, column } = textPosition(text, index)
  const code = text.charCodeAt(index)
  const next = text.charCodeAt(index + 1)
  const isPairStart = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  if (code >= 0xd800 && code <= 0xdfff && !isPairStart)
    return new AppError('VALIDATION', workbenchMainText('codec.loneSurrogate', { line, column }))

  const char = text.slice(index, isPairStart ? index + 2 : index + 1)
  return new AppError(
    WorkbenchUnencodableTextErrorCode,
    workbenchMainText('codec.unencodable', {
      line,
      column,
      char,
      encoding: formatWorkbenchTextEncoding(encoding),
    })
  )
}

function textPosition(text: string, index: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (
    let newline = text.indexOf('\n');
    newline !== -1 && newline < index;
    newline = text.indexOf('\n', newline + 1)
  ) {
    line += 1
    lineStart = newline + 1
  }
  return { line, column: index - lineStart + 1 }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
}

export {
  countWorkbenchTextLines,
  decodeWorkbenchText,
  decodeWorkbenchTextContent,
  detectWorkbenchTextBom,
  encodeWorkbenchText,
}
export type { DecodedWorkbenchText, WorkbenchTextBom }
