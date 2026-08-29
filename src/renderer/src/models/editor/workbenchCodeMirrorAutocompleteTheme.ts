import { EditorView } from '@codemirror/view'

import {
  isWorkbenchDarkTheme,
  type WorkbenchThemeId,
} from '../settings/workbenchPreferences'

function completionIconMask(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const CompletionIconMasks = {
  class: completionIconMask('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M10.5 5.25a3.25 3.25 0 1 0 0 5.5"/>'),
  constant: completionIconMask('<rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5"/><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7"/>'),
  enum: completionIconMask('<circle cx="3.25" cy="4" r=".75"/><circle cx="3.25" cy="8" r=".75"/><circle cx="3.25" cy="12" r=".75"/><path d="M6 4h7M6 8h7M6 12h7"/>'),
  function: completionIconMask('<path d="M10.75 2.5H8.5A2.5 2.5 0 0 0 6 5v6a2.5 2.5 0 0 1-2.5 2.5H2.25M3.75 8h5.5"/>'),
  interface: completionIconMask('<rect x="2.25" y="4.25" width="8.5" height="8.5" rx="1.5"/><path d="M5.25 4.25V3.5A1.25 1.25 0 0 1 6.5 2.25h5A2.25 2.25 0 0 1 13.75 4.5v5A1.25 1.25 0 0 1 12.5 10.75h-.75"/>'),
  keyword: completionIconMask('<circle cx="5.25" cy="6" r="3"/><path d="M7.5 8.25 13.25 14M10.25 11l1.5-1.5M11.75 12.5l1.5-1.5"/>'),
  method: completionIconMask('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 8h6M8 5v6"/>'),
  namespace: completionIconMask('<path d="m8 2 5.25 3v6L8 14l-5.25-3V5L8 2Z"/><path d="m2.75 5 5.25 3 5.25-3M8 8v6"/>'),
  property: completionIconMask('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><circle cx="5" cy="4" r="1.25"/><circle cx="10.5" cy="8" r="1.25"/><circle cx="7" cy="12" r="1.25"/>'),
  tag: completionIconMask('<path d="m6 3-4 5 4 5M10 3l4 5-4 5"/>'),
  text: completionIconMask('<path d="M2.5 4h11M2.5 8h8M2.5 12h11"/>'),
  type: completionIconMask('<circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="4" r="1.5"/><circle cx="8" cy="12" r="1.5"/><path d="m5.25 4.75 1.9 5.8M10.75 4.75l-1.9 5.8M5.5 4h5"/>'),
  variable: completionIconMask('<circle cx="8" cy="8" r="5.25"/><path d="M5.25 8h5.5M8 5.25v5.5"/>'),
} as const

function iconGlyphStyle(color: string, maskImage: string) {
  return {
    border: '0',
    borderRadius: '2px',
    backgroundColor: color,
    color,
    WebkitMaskImage: maskImage,
    WebkitMaskPosition: 'center',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskSize: '1em 1em',
    maskImage,
    maskPosition: 'center',
    maskRepeat: 'no-repeat',
    maskSize: '1em 1em',
  }
}

function createWorkbenchAutocompleteTheme(isDark: boolean) {
  const popupBg = 'var(--workbench-editor-tooltip-bg, var(--workbench-bg))'
  const popupBorder = 'var(--workbench-border)'
  const popupFg = 'var(--workbench-text)'
  const selectedBg = `color-mix(
    in oklab,
    var(--workbench-theme-color) ${isDark ? '22%' : '14%'},
    var(--workbench-editor-tooltip-bg, var(--workbench-bg))
  )`
  const selectedFg = 'var(--workbench-text)'
  const selectedAccent = 'var(--workbench-theme-color)'
  const detailColor = 'var(--workbench-text-muted)'
  const selectedMetadataColor = `color-mix(
    in oklab,
    var(--workbench-text-muted) 70%,
    var(--workbench-theme-color)
  )`
  const matchedColor = 'var(--workbench-active-fg, var(--workbench-theme-color))'

  const iconFunction = isDark ? '#f48771' : '#c44b42'
  const iconMethod = isDark ? '#dcdcaa' : '#795e26'
  const iconClass = isDark ? '#4ec9b0' : '#267f99'
  const iconInterface = isDark ? '#4ec9b0' : '#267f99'
  const iconVariable = isDark ? '#9cdcfe' : '#001080'
  const iconProperty = isDark ? '#9cdcfe' : '#871094'
  const iconKeyword = isDark ? '#c586c0' : '#0000ff'
  const iconType = isDark ? '#4ec9b0' : '#267f99'
  const iconConstant = isDark ? '#4fc1ff' : '#0070c1'
  const iconEnum = isDark ? '#b8d7a3' : '#2b91af'
  const iconNamespace = isDark ? '#c8c8c8' : '#444444'
  const iconTag = isDark ? '#569cd6' : '#800000'
  const iconText = isDark ? '#a8a8a8' : '#616161'

  const iconBase = {
    width: '1.25em',
    minWidth: '1.25em',
    height: '1.25em',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '0',
    backgroundImage: 'none',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '0.78em',
    fontWeight: '650',
    fontStyle: 'normal',
    lineHeight: '1',
    opacity: '1',
    padding: '0',
    boxSizing: 'border-box',
    flexShrink: '0',
  } as const

  return EditorView.theme(
    {
      '.cm-tooltip.cm-tooltip-autocomplete': {
        border: `1px solid ${popupBorder}`,
        borderRadius: '6px',
        backgroundColor: popupBg,
        color: popupFg,
        boxShadow: isDark
          ? '0 10px 28px rgba(0, 0, 0, 0.48)'
          : '0 10px 28px rgba(15, 23, 42, 0.16)',
        overflow: 'hidden',
        padding: '0',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 'var(--workbench-editor-font-size, 12.5px)',
        lineHeight: 'var(--workbench-editor-line-height, 20.25px)',
        fontVariantLigatures: 'none',
        maxHeight: 'min(calc(var(--workbench-editor-line-height, 20.25px) * 12), 48vh)',
        minWidth: 'min(34em, calc(100vw - 24px))',
        maxWidth: 'min(760px, calc(100vw - 24px))',
        padding: '3px',
        margin: '0',
        scrollbarWidth: 'thin',
        scrollbarColor: 'color-mix(in oklab, var(--workbench-text-muted) 42%, transparent) transparent',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li': {
        display: 'flex',
        alignItems: 'center',
        gap: '0.48em',
        minHeight: 'max(1.8em, var(--workbench-editor-line-height, 20.25px))',
        margin: '0',
        padding: '0.12em 0.62em 0.12em 0.42em',
        border: '0',
        borderRadius: '3px',
        color: popupFg,
        cursor: 'default',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: selectedBg,
        color: selectedFg,
        boxShadow: `inset 2px 0 0 ${selectedAccent}`,
      },
      '.cm-completionLabel': {
        flex: '0 1 auto',
        minWidth: '4em',
        maxWidth: '44%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: popupFg,
        fontWeight: '450',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionLabel': {
        color: selectedFg,
      },
      '.cm-completionDetail': {
        flex: '1 1 auto',
        minWidth: '0',
        marginLeft: '0.2em',
        overflow: 'hidden',
        color: detailColor,
        fontSize: '0.88em',
        fontStyle: 'normal',
        opacity: '1',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': {
        color: selectedMetadataColor,
      },
      '.cm-workbenchCompletionType': {
        flex: '0 1 auto',
        maxWidth: '38%',
        minWidth: '0',
        marginLeft: 'auto',
        paddingLeft: '0.8em',
        overflow: 'hidden',
        color: detailColor,
        fontSize: '0.88em',
        fontStyle: 'normal',
        textAlign: 'right',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-workbenchCompletionType': {
        color: selectedMetadataColor,
      },
      '.cm-completionMatchedText': {
        color: matchedColor,
        fontWeight: '700',
        textDecoration: 'none',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionMatchedText': {
        color: selectedAccent,
      },
      '.cm-completionIcon': iconBase,
      '.cm-completionIcon-function': iconGlyphStyle(iconFunction, CompletionIconMasks.function),
      '.cm-completionIcon-method': iconGlyphStyle(iconMethod, CompletionIconMasks.method),
      '.cm-completionIcon-class': iconGlyphStyle(iconClass, CompletionIconMasks.class),
      '.cm-completionIcon-interface': iconGlyphStyle(iconInterface, CompletionIconMasks.interface),
      '.cm-completionIcon-variable': iconGlyphStyle(iconVariable, CompletionIconMasks.variable),
      '.cm-completionIcon-property': iconGlyphStyle(iconProperty, CompletionIconMasks.property),
      '.cm-completionIcon-keyword': iconGlyphStyle(iconKeyword, CompletionIconMasks.keyword),
      '.cm-completionIcon-type': iconGlyphStyle(iconType, CompletionIconMasks.type),
      '.cm-completionIcon-constant': iconGlyphStyle(iconConstant, CompletionIconMasks.constant),
      '.cm-completionIcon-enum': iconGlyphStyle(iconEnum, CompletionIconMasks.enum),
      '.cm-completionIcon-namespace': iconGlyphStyle(iconNamespace, CompletionIconMasks.namespace),
      '.cm-completionIcon-tag': iconGlyphStyle(iconTag, CompletionIconMasks.tag),
      '.cm-completionIcon-text': iconGlyphStyle(iconText, CompletionIconMasks.text),
      '.cm-tooltip.cm-completionInfo': {
        boxSizing: 'border-box',
        maxWidth: 'min(620px, calc(100vw - 24px))',
        maxHeight: 'min(360px, 45vh)',
        padding: '0.65em 0.8em',
        border: `1px solid ${popupBorder}`,
        borderRadius: '6px',
        backgroundColor: popupBg,
        color: popupFg,
        boxShadow: isDark
          ? '0 10px 26px rgba(0, 0, 0, 0.42)'
          : '0 10px 26px rgba(15, 23, 42, 0.14)',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 'var(--workbench-editor-font-size, 12.5px)',
        lineHeight: '1.5',
        overflow: 'auto',
        scrollbarWidth: 'thin',
      },
    },
    { dark: isDark }
  )
}

export function getWorkbenchCodeMirrorAutocompleteTheme(theme: WorkbenchThemeId) {
  return createWorkbenchAutocompleteTheme(isWorkbenchDarkTheme(theme))
}
