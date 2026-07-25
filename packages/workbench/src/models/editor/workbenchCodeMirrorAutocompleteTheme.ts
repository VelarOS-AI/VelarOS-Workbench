import { EditorView } from '@codemirror/view'

import {
  isWorkbenchDarkTheme,
  type WorkbenchThemeId,
} from '../settings/workbenchPreferences'

function iconCircleStyle(background: string, border: string) {
  return {
    backgroundColor: background,
    border: `1px solid ${border}`,
    borderRadius: '50%',
  }
}

function createWorkbenchAutocompleteTheme(isDark: boolean) {
  const popupBg = isDark ? '#2b2d30' : '#ffffff'
  const popupBorder = isDark ? '#45494f' : '#c8ccd4'
  const popupFg = isDark ? '#bcbec4' : '#000000'
  const selectedBg = isDark ? '#2f3b4e' : '#edf3ff'
  const selectedFg = isDark ? '#dfe1e5' : '#000000'
  const selectedAccent = isDark ? '#548af7' : '#4f8cff'
  const detailColor = isDark ? '#7a8490' : '#808080'
  const typeColor = isDark ? '#7a8490' : '#808080'
  const matchedColor = isDark ? '#6aabf5' : '#0066cc'

  const iconFunction = isDark ? '#f75464' : '#e05555'
  const iconMethod = isDark ? '#f75464' : '#e05555'
  const iconClass = isDark ? '#56c3d6' : '#4a8bbe'
  const iconInterface = isDark ? '#56c3d6' : '#4a8bbe'
  const iconVariable = isDark ? '#cf8e00' : '#cf8e00'
  const iconProperty = isDark ? '#cf8e00' : '#cf8e00'
  const iconType = isDark ? '#56c3d6' : '#4a8bbe'
  const iconConstant = isDark ? '#2aacb8' : '#4a8bbe'
  const iconEnum = isDark ? '#c8a56c' : '#a16207'
  const iconNamespace = isDark ? '#c8a56c' : '#a16207'
  const iconTag = isDark ? '#e8b86d' : '#b45309'
  const iconText = isDark ? '#9aa3b2' : '#64748b'

  const iconBase = {
    width: '16px',
    minWidth: '16px',
    height: '16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '9px',
    fontWeight: '700',
    lineHeight: '1',
    opacity: '1',
    padding: '0',
    boxSizing: 'border-box',
    flexShrink: '0',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  } as const

  return EditorView.theme(
    {
      '.cm-tooltip.cm-tooltip-autocomplete': {
        border: `1px solid ${popupBorder}`,
        borderRadius: '4px',
        backgroundColor: popupBg,
        color: popupFg,
        boxShadow: isDark ? '0 8px 24px rgba(0, 0, 0, 0.45)' : '0 4px 16px rgba(0, 0, 0, 0.12)',
        overflow: 'hidden',
        padding: '0',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: '12px',
        lineHeight: '1.35',
        maxHeight: '280px',
        minWidth: '320px',
        maxWidth: 'min(680px, 92vw)',
        padding: '2px 0',
        margin: '0',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li': {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minHeight: '22px',
        padding: '2px 8px 2px 6px',
        borderLeft: '2px solid transparent',
        cursor: 'default',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: selectedBg,
        color: selectedFg,
        borderLeftColor: selectedAccent,
      },
      '.cm-completionLabel': {
        flex: '0 1 auto',
        minWidth: '0',
        maxWidth: '40%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: '400',
        color: popupFg,
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionLabel': {
        color: selectedFg,
      },
      '.cm-completionDetail': {
        flex: '1 1 auto',
        minWidth: '0',
        marginLeft: '4px',
        color: detailColor,
        fontSize: '11px',
        fontStyle: 'normal',
        opacity: '1',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': {
        color: detailColor,
      },
      '.cm-workbenchCompletionType': {
        flex: '0 0 auto',
        marginLeft: 'auto',
        paddingLeft: '12px',
        color: typeColor,
        fontSize: '11px',
        fontStyle: 'normal',
        maxWidth: '42%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-workbenchCompletionType': {
        color: typeColor,
      },
      '.cm-completionMatchedText': {
        color: matchedColor,
        fontWeight: '700',
        textDecoration: 'none',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionMatchedText': {
        color: matchedColor,
      },
      '.cm-completionIcon': iconBase,
      '.cm-completionIcon-function': iconCircleStyle(
        isDark ? '#4a2828' : '#ffecec',
        isDark ? '#8f4848' : '#e05555'
      ),
      '.cm-completionIcon-function::after': { content: "'f'", color: iconFunction },
      '.cm-completionIcon-method': iconCircleStyle(
        isDark ? '#4a2828' : '#ffecec',
        isDark ? '#8f4848' : '#e05555'
      ),
      '.cm-completionIcon-method::after': { content: "'f'", color: iconMethod },
      '.cm-completionIcon-class': iconCircleStyle(
        isDark ? '#1f3d45' : '#e8f4fc',
        isDark ? '#3d7f8d' : '#4a8bbe'
      ),
      '.cm-completionIcon-class::after': { content: "'C'", color: iconClass },
      '.cm-completionIcon-interface': iconCircleStyle(
        isDark ? '#1f3d45' : '#e8f4fc',
        isDark ? '#3d7f8d' : '#4a8bbe'
      ),
      '.cm-completionIcon-interface::after': { content: "'I'", color: iconInterface },
      '.cm-completionIcon-variable': iconCircleStyle(
        isDark ? '#4a3a20' : '#fff6e6',
        isDark ? '#9a7b30' : '#cf8e00'
      ),
      '.cm-completionIcon-variable::after': { content: "'v'", color: iconVariable },
      '.cm-completionIcon-property': iconCircleStyle(
        isDark ? '#4a3a20' : '#fff6e6',
        isDark ? '#9a7b30' : '#cf8e00'
      ),
      '.cm-completionIcon-property::after': { content: "'v'", color: iconProperty },
      '.cm-completionIcon-keyword': {
        display: 'none',
        width: '0',
        minWidth: '0',
        height: '0',
        margin: '0',
        padding: '0',
      },
      '.cm-completionIcon-type': iconCircleStyle(
        isDark ? '#1f3d45' : '#e8f4fc',
        isDark ? '#3d7f8d' : '#4a8bbe'
      ),
      '.cm-completionIcon-type::after': { content: "'T'", color: iconType },
      '.cm-completionIcon-constant': iconCircleStyle(
        isDark ? '#1f3550' : '#e8f4fc',
        isDark ? '#4f7fd6' : '#4a8bbe'
      ),
      '.cm-completionIcon-constant::after': { content: "'c'", color: iconConstant },
      '.cm-completionIcon-enum': iconCircleStyle(
        isDark ? '#4a3f28' : '#fef3c7',
        isDark ? '#9a7b3c' : '#d97706'
      ),
      '.cm-completionIcon-enum::after': { content: "'E'", color: iconEnum },
      '.cm-completionIcon-namespace': iconCircleStyle(
        isDark ? '#4a3f28' : '#fef3c7',
        isDark ? '#9a7b3c' : '#d97706'
      ),
      '.cm-completionIcon-namespace::after': { content: "'M'", color: iconNamespace },
      '.cm-completionIcon-tag': iconCircleStyle(
        isDark ? '#4a3a28' : '#ffedd5',
        isDark ? '#b4834e' : '#ea580c'
      ),
      '.cm-completionIcon-tag::after': { content: "'</>'", color: iconTag, fontSize: '6px' },
      '.cm-completionIcon-text': iconCircleStyle(
        isDark ? '#353941' : '#f1f5f9',
        isDark ? '#5d6675' : '#94a3b8'
      ),
      '.cm-completionIcon-text::after': { content: "'ab'", color: iconText, fontSize: '7px' },
      '.cm-tooltip.cm-completionInfo': {
        border: `1px solid ${popupBorder}`,
        borderRadius: '4px',
        backgroundColor: isDark ? '#313438' : '#ffffff',
        color: popupFg,
        padding: '6px 8px',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: '11px',
        lineHeight: '1.45',
        boxShadow: isDark ? '0 8px 20px rgba(0, 0, 0, 0.36)' : '0 4px 14px rgba(0, 0, 0, 0.1)',
      },
    },
    { dark: isDark }
  )
}

export function getWorkbenchCodeMirrorAutocompleteTheme(theme: WorkbenchThemeId) {
  return createWorkbenchAutocompleteTheme(isWorkbenchDarkTheme(theme))
}
