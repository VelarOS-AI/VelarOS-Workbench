import { EditorView } from '@codemirror/view'

import { getWorkbenchJetBrainsIcon } from '../workbenchJetBrainsIcons'
import { isWorkbenchDarkTheme, type WorkbenchThemeId } from '../workbenchPreferences'

import { getWorkbenchCodeTokenPalette } from './workbenchCodeMirrorTheme'

const Popup = '.cm-tooltip.cm-tooltip-autocomplete'
const Row = `${Popup} > ul > li[role="option"]`
const Selected = `${Row}[aria-selected="true"]`
const Icon = `${Row} .cm-completionIcon`
const Preview = '.cm-tooltip.cm-completionInfo'
const Mono = 'var(--font-mono, ui-monospace, monospace)'
const Muted = 'var(--workbench-text-muted)'
const Ink = 'var(--workbench-text)'
const Surface = 'var(--workbench-editor-tooltip-bg, var(--workbench-bg))'
const Accent = 'var(--workbench-theme-color)'
const EditorFontSize = 'var(--workbench-editor-font-size, 12.5px)'
const EditorLineHeight = 'var(--workbench-editor-line-height, 20.25px)'

const CompletionIcons: Record<string, string> = {
  class: 'node-class',
  color: 'node-property',
  constant: 'node-constant',
  constructor: 'node-constructor',
  enum: 'node-enum',
  'enum-member': 'node-field',
  event: 'node-method',
  file: 'file-text',
  folder: 'node-folder',
  function: 'node-function',
  interface: 'node-interface',
  keyword: 'node-word',
  method: 'node-method',
  namespace: 'node-module',
  operator: 'node-word',
  parameter: 'node-parameter',
  property: 'node-property',
  snippet: 'node-template',
  tag: 'node-tag',
  text: 'node-word',
  type: 'node-type',
  value: 'node-constant',
  variable: 'node-variable',
}

function createWorkbenchAutocompleteTheme(theme: WorkbenchThemeId) {
  const dark = isWorkbenchDarkTheme(theme)
  const palette = getWorkbenchCodeTokenPalette(theme)
  const border = '1px solid var(--workbench-border)'
  const shadow = dark ? '0 8px 22px #0008, 0 1px 3px #0008' : '0 8px 22px #17213826, 0 1px 3px #1721381c'
  const selected = `color-mix(in oklab, ${Accent} ${dark ? 22 : 14}%, ${Surface})`
  const match = `color-mix(in oklab, ${Accent} ${dark ? 65 : 62}%, ${Ink})`
  const iconUrl = (name: string) => `url("${getWorkbenchJetBrainsIcon(name, dark)}")`
  const kindStyles = Object.fromEntries(
    Object.entries(CompletionIcons).map(([kind, asset]) => [
      `${Icon}.cm-completionIcon-${kind}`,
      { backgroundImage: iconUrl(asset) },
    ])
  )
  const syntaxColors = {
    keyword: palette.keyword, builtinType: palette.type, type: palette.type,
    name: palette.property, function: palette.function, number: palette.number, string: palette.string,
    operator: palette.operator, link: palette.link,
  }
  const syntaxStyles = Object.fromEntries(Object.entries(syntaxColors).map(([role, color]) => [
    `${Preview} .cm-workbenchCompletionToken-${role}`, { color },
  ]))
  const ellipsis = { minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }
  const metadata = { ...ellipsis, fontSize: '0.88em', color: Muted, fontStyle: 'normal' }

  return EditorView.theme(
    {
      [Popup]: {
        padding: '0',
        border,
        borderRadius: '7px',
        color: Ink,
        backgroundColor: Surface,
        boxShadow: shadow,
        overflow: 'visible',
      },
      [`${Popup} > ul`]: {
        boxSizing: 'border-box',
        width: 'min(clamp(19em, 33vw, 36em), calc(100vw - 24px))',
        maxWidth: 'none',
        maxHeight: `min(calc((${EditorLineHeight} + 4px) * 10 + 8px), 44vh)`,
        margin: '0',
        padding: '4px',
        borderRadius: 'inherit',
        fontFamily: Mono,
        fontSize: EditorFontSize,
        lineHeight: EditorLineHeight,
        fontVariantLigatures: 'none',
        scrollbarWidth: 'thin',
        scrollbarColor: `color-mix(in oklab, ${Muted} 45%, transparent) transparent`,
        scrollbarGutter: 'stable',
      },
      [Row]: {
        boxSizing: 'border-box',
        display: 'grid',
        gridTemplateColumns: '1.7em auto minmax(0, 1fr) minmax(0, max-content)',
        alignItems: 'center',
        columnGap: '0.58em',
        minHeight: `calc(${EditorLineHeight} + 4px)`,
        padding: '2px 8px 2px 5px',
        margin: '0',
        border: '0',
        borderRadius: '4px',
        backgroundColor: 'transparent',
        color: Ink,
        cursor: 'default',
      },
      [`${Row}:not([aria-selected="true"]):hover`]: {
        backgroundColor: `color-mix(in oklab, ${Ink} 5%, ${Surface})`,
      },
      [Selected]: {
        backgroundColor: selected,
        color: Ink,
      },
      [`${Row} .cm-completionLabel`]: {
        ...ellipsis,
        gridColumn: '2',
        maxWidth: 'min(24ch, 43vw)',
        color: Ink,
        fontWeight: '520',
      },
      [`${Row}.cm-workbenchCompletionDeprecated .cm-completionLabel`]: {
        color: Muted,
        textDecoration: 'line-through',
      },
      [`${Row} .cm-completionMatchedText`]: {
        color: match,
        fontWeight: '700',
        textDecoration: 'none',
      },
      [`${Row} .cm-completionDetail`]: { ...metadata, gridColumn: '3', margin: '0', opacity: '1' },
      [`${Row} .cm-workbenchCompletionType, ${Row} .cm-workbenchCompletionSource`]: {
        ...metadata,
        gridColumn: '4',
        justifySelf: 'end',
        maxWidth: 'min(19ch, 25vw)',
        textAlign: 'end',
      },
      [`${Row} .cm-workbenchCompletionSource`]: {
        fontFamily: 'var(--font-ui, system-ui, sans-serif)',
        unicodeBidi: 'plaintext',
      },
      [Icon]: {
        gridColumn: '1',
        display: 'grid',
        placeItems: 'center',
        boxSizing: 'border-box',
        inlineSize: '1.55em',
        blockSize: '1.55em',
        minWidth: '0',
        padding: '0',
        border: '0',
        borderRadius: '4px',
        backgroundImage: iconUrl('node-word'),
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundSize: '1.28em 1.28em',
        fontSize: 'inherit',
        opacity: '1',
      },
      [`${Icon}::after`]: { content: 'none' },
      ...kindStyles,
      [Preview]: {
        boxSizing: 'border-box',
        padding: '0',
        border,
        borderRadius: '7px',
        color: Ink,
        backgroundColor: Surface,
        boxShadow: shadow,
        fontSize: EditorFontSize,
        lineHeight: '1.5',
        overflow: 'auto',
        scrollbarWidth: 'thin',
      },
      [`${Preview}:has(> .cm-workbenchCompletionPreview[hidden])`]: {
        visibility: 'hidden',
        pointerEvents: 'none',
      },
      '.cm-workbenchCompletionSignature': {
        display: 'block',
        padding: '8px 10px',
        backgroundColor: `color-mix(in oklab, ${Ink} 4%, ${Surface})`,
        fontFamily: Mono,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      '.cm-workbenchCompletionDocumentation': {
        padding: '8px 10px',
        fontFamily: 'var(--font-ui, system-ui, sans-serif)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      '.cm-workbenchCompletionDocumentation code': {
        fontFamily: Mono,
        backgroundColor: `color-mix(in oklab, ${Ink} 6%, ${Surface})`,
      },
      '.cm-workbenchCompletionCodeBlock': {
        display: 'block',
        padding: '6px 8px',
        margin: '5px 0',
        borderRadius: '4px',
      },
      '.cm-workbenchCompletionDocumentation a': {
        color: palette.link,
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
      },
      ...syntaxStyles,
      '.cm-workbenchCompletionOrigin': {
        padding: '6px 10px',
        borderTop: border,
        color: Muted,
        fontFamily: Mono,
        fontSize: '0.86em',
        overflowWrap: 'anywhere',
      },
    },
    { dark }
  )
}

export function getWorkbenchCodeMirrorAutocompleteTheme(theme: WorkbenchThemeId) {
  return createWorkbenchAutocompleteTheme(theme)
}
