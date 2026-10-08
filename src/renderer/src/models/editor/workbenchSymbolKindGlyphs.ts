/**
 * 符号种类的图标：一套 16×16 的线条图。补全列表与「转到文件中的符号」共用，同一种东西在两处长得一样。
 * 图标当遮罩用（颜色由用的地方给），所以这里只有形状。
 */
import { type WorkbenchLanguageServiceDocumentSymbolKind } from '@shared/contracts/workbench'

function glyphMask(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** 每种图标的 CSS 遮罩（`mask-image` 的值）。 */
export const WorkbenchSymbolKindGlyphMasks = {
  class: glyphMask('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M10.5 5.25a3.25 3.25 0 1 0 0 5.5"/>'),
  constant: glyphMask('<rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5"/><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7"/>'),
  enum: glyphMask('<circle cx="3.25" cy="4" r=".75"/><circle cx="3.25" cy="8" r=".75"/><circle cx="3.25" cy="12" r=".75"/><path d="M6 4h7M6 8h7M6 12h7"/>'),
  function: glyphMask('<path d="M10.75 2.5H8.5A2.5 2.5 0 0 0 6 5v6a2.5 2.5 0 0 1-2.5 2.5H2.25M3.75 8h5.5"/>'),
  interface: glyphMask('<rect x="2.25" y="4.25" width="8.5" height="8.5" rx="1.5"/><path d="M5.25 4.25V3.5A1.25 1.25 0 0 1 6.5 2.25h5A2.25 2.25 0 0 1 13.75 4.5v5A1.25 1.25 0 0 1 12.5 10.75h-.75"/>'),
  keyword: glyphMask('<circle cx="5.25" cy="6" r="3"/><path d="M7.5 8.25 13.25 14M10.25 11l1.5-1.5M11.75 12.5l1.5-1.5"/>'),
  method: glyphMask('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 8h6M8 5v6"/>'),
  namespace: glyphMask('<path d="m8 2 5.25 3v6L8 14l-5.25-3V5L8 2Z"/><path d="m2.75 5 5.25 3 5.25-3M8 8v6"/>'),
  property: glyphMask('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><circle cx="5" cy="4" r="1.25"/><circle cx="10.5" cy="8" r="1.25"/><circle cx="7" cy="12" r="1.25"/>'),
  tag: glyphMask('<path d="m6 3-4 5 4 5M10 3l4 5-4 5"/>'),
  text: glyphMask('<path d="M2.5 4h11M2.5 8h8M2.5 12h11"/>'),
  type: glyphMask('<circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="4" r="1.5"/><circle cx="8" cy="12" r="1.5"/><path d="m5.25 4.75 1.9 5.8M10.75 4.75l-1.9 5.8M5.5 4h5"/>'),
  variable: glyphMask('<circle cx="8" cy="8" r="5.25"/><path d="M5.25 8h5.5M8 5.25v5.5"/>'),
} as const

export type WorkbenchSymbolKindGlyph = keyof typeof WorkbenchSymbolKindGlyphMasks

const DocumentSymbolGlyphs: Readonly<
  Record<WorkbenchLanguageServiceDocumentSymbolKind, WorkbenchSymbolKindGlyph>
> = {
  class: 'class',
  constant: 'constant',
  constructor: 'method',
  enum: 'enum',
  'enum-member': 'property',
  function: 'function',
  interface: 'interface',
  method: 'method',
  module: 'namespace',
  property: 'property',
  // 没有更细的种类可说的（Markdown 的标题、语言服务器给的别的东西）。
  symbol: 'text',
  type: 'type',
  variable: 'variable',
}

/** 大纲里一种符号用哪个图标。 */
export function workbenchDocumentSymbolGlyphMask(kind: WorkbenchLanguageServiceDocumentSymbolKind): string {
  return WorkbenchSymbolKindGlyphMasks[DocumentSymbolGlyphs[kind]]
}
