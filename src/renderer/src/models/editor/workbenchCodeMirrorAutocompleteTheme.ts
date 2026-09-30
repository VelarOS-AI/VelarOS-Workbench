import { EditorView } from '@codemirror/view'

import {
  isWorkbenchDarkTheme,
  type WorkbenchThemeId,
} from '../settings/workbenchPreferences'

import { WorkbenchSymbolKindGlyphMasks } from './workbenchSymbolKindGlyphs'

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
      '.cm-completionIcon-function': iconGlyphStyle(iconFunction, WorkbenchSymbolKindGlyphMasks.function),
      '.cm-completionIcon-method': iconGlyphStyle(iconMethod, WorkbenchSymbolKindGlyphMasks.method),
      '.cm-completionIcon-class': iconGlyphStyle(iconClass, WorkbenchSymbolKindGlyphMasks.class),
      '.cm-completionIcon-interface': iconGlyphStyle(iconInterface, WorkbenchSymbolKindGlyphMasks.interface),
      '.cm-completionIcon-variable': iconGlyphStyle(iconVariable, WorkbenchSymbolKindGlyphMasks.variable),
      '.cm-completionIcon-property': iconGlyphStyle(iconProperty, WorkbenchSymbolKindGlyphMasks.property),
      '.cm-completionIcon-keyword': iconGlyphStyle(iconKeyword, WorkbenchSymbolKindGlyphMasks.keyword),
      '.cm-completionIcon-type': iconGlyphStyle(iconType, WorkbenchSymbolKindGlyphMasks.type),
      '.cm-completionIcon-constant': iconGlyphStyle(iconConstant, WorkbenchSymbolKindGlyphMasks.constant),
      '.cm-completionIcon-enum': iconGlyphStyle(iconEnum, WorkbenchSymbolKindGlyphMasks.enum),
      '.cm-completionIcon-namespace': iconGlyphStyle(iconNamespace, WorkbenchSymbolKindGlyphMasks.namespace),
      '.cm-completionIcon-tag': iconGlyphStyle(iconTag, WorkbenchSymbolKindGlyphMasks.tag),
      '.cm-completionIcon-text': iconGlyphStyle(iconText, WorkbenchSymbolKindGlyphMasks.text),
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
