import { HighlightStyle, syntaxHighlighting, type TagStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

import { isWorkbenchDarkTheme, type WorkbenchThemeId } from '../workbenchPreferences'

export interface WorkbenchCodeTokenPalette {
  comment: string
  decorator: string
  escape: string
  frameworkDefinition: string
  function: string
  heading: string
  invalid: string
  keyword: string
  link: string
  monospace: string
  number: string
  operator: string
  property: string
  string: string
  type: string
  variable: string
}

export function getWorkbenchCodeTokenPalette(theme: WorkbenchThemeId): WorkbenchCodeTokenPalette {
  switch (theme) {
    case 'warm-paper':
      return {
        comment: '#998773',
        decorator: '#a16207',
        escape: '#2f7d4f',
        frameworkDefinition: '#2563eb',
        function: '#8b5e1a',
        heading: '#7c3aed',
        invalid: '#b91c1c',
        keyword: '#7c3aed',
        link: '#0369a1',
        monospace: '#8b5e1a',
        number: '#b45309',
        operator: '#5b4635',
        property: '#9d174d',
        string: '#557a1f',
        type: '#0f766e',
        variable: '#3d3025',
      }
    case 'midnight-blue':
      return {
        comment: '#637777',
        decorator: '#ffcb6b',
        escape: '#c3e88d',
        frameworkDefinition: '#a6e22e',
        function: '#82aaff',
        heading: '#82aaff',
        invalid: '#ff5370',
        keyword: '#c792ea',
        link: '#80cbc4',
        monospace: '#f78c6c',
        number: '#f78c6c',
        operator: '#89ddff',
        property: '#f07178',
        string: '#addb67',
        type: '#89ddff',
        variable: '#d6deeb',
      }
    case 'dark-modern':
      return {
        comment: '#7a808b',
        decorator: '#c8a56c',
        escape: '#7dd38d',
        frameworkDefinition: '#ff8c42',
        function: '#ffd580',
        heading: '#8ab4f8',
        invalid: '#ff7373',
        keyword: '#569cd6',
        link: '#6aa8ff',
        monospace: '#ce9178',
        number: '#2aacb8',
        operator: '#bfc7d5',
        property: '#e394dc',
        string: '#6aab73',
        type: '#4ec9b0',
        variable: '#d8dee9',
      }
    default:
      return {
        comment: '#707070',
        decorator: '#808000',
        escape: '#055f12',
        frameworkDefinition: '#6f42c1',
        function: '#a04b00',
        heading: '#0033b3',
        invalid: '#bc3f3c',
        keyword: '#0033b3',
        link: '#2456b3',
        monospace: '#a04b00',
        number: '#1750eb',
        operator: '#000000',
        property: '#a31574',
        string: '#067d17',
        type: '#007f73',
        variable: '#202124',
      }
  }
}

const highlightSpecsByTheme = new Map<WorkbenchThemeId, readonly TagStyle[]>()

/**
 * 语法着色规则（标签 → 颜色、粗细、斜体、下划线）：编辑器按它生成 HighlightStyle，搜索结果里的代码片段也按它
 * 着色，两边颜色一致。
 */
export function getWorkbenchCodeHighlightSpecs(theme: WorkbenchThemeId): readonly TagStyle[] {
  const cached = highlightSpecsByTheme.get(theme)
  if (cached) return cached
  const specs = createWorkbenchHighlightSpecs(theme)
  highlightSpecsByTheme.set(theme, specs)
  return specs
}

function createWorkbenchHighlightStyle(theme: WorkbenchThemeId): HighlightStyle {
  return HighlightStyle.define([...getWorkbenchCodeHighlightSpecs(theme)])
}

function createWorkbenchHighlightSpecs(theme: WorkbenchThemeId): TagStyle[] {
  const palette = getWorkbenchCodeTokenPalette(theme)
  return [
    {
      tag: [
        tags.keyword,
        tags.modifier,
        tags.controlKeyword,
        tags.definitionKeyword,
        tags.moduleKeyword,
        tags.operatorKeyword,
        tags.self,
      ],
      color: palette.keyword,
    },
    {
      tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator],
      color: palette.operator,
    },
    {
      tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
      color: palette.string,
    },
    {
      tag: [tags.escape, tags.regexp],
      color: palette.escape,
    },
    {
      tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
      color: palette.number,
    },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: palette.comment,
      fontStyle: 'italic',
    },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: palette.function,
    },
    {
      tag: tags.special(tags.definition(tags.variableName)),
      color: palette.frameworkDefinition,
    },
    {
      tag: [
        tags.className,
        tags.typeName,
        tags.tagName,
        tags.namespace,
        tags.definition(tags.typeName),
      ],
      color: palette.type,
    },
    {
      tag: [tags.propertyName, tags.attributeName],
      color: palette.property,
    },
    {
      tag: tags.monospace,
      color: palette.monospace,
    },
    {
      tag: [tags.variableName, tags.name],
      color: palette.variable,
    },
    {
      tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.macroName],
      color: palette.decorator,
    },
    {
      tag: [tags.heading, tags.strong],
      color: palette.heading,
      fontWeight: '600',
    },
    {
      tag: [tags.link, tags.url],
      color: palette.link,
      textDecoration: 'underline',
    },
    {
      tag: tags.invalid,
      color: palette.invalid,
      textDecoration: `underline wavy ${palette.invalid}`,
    },
  ]
}

export const workbenchCodeMirrorRiderTheme: Extension = syntaxHighlighting(
  createWorkbenchHighlightStyle('light-modern')
)

const workbenchCodeMirrorWarmPaperTheme: Extension = syntaxHighlighting(
  createWorkbenchHighlightStyle('warm-paper')
)

const workbenchCodeMirrorDarculaTheme: Extension = syntaxHighlighting(
  createWorkbenchHighlightStyle('dark-modern')
)

const workbenchCodeMirrorMidnightBlueTheme: Extension = syntaxHighlighting(
  createWorkbenchHighlightStyle('midnight-blue')
)

function diagnosticUnderlineBackground(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3"><path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${color}" fill="none" stroke-width=".7"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

export function getWorkbenchCodeMirrorLintTheme(theme: WorkbenchThemeId): Extension {
  const dark = isWorkbenchDarkTheme(theme)
  const errorUnderline = diagnosticUnderlineBackground(dark ? '#f14c4c' : '#e51400')
  const warningUnderline = diagnosticUnderlineBackground(dark ? '#cca700' : '#bf8803')
  const hintUnderline = diagnosticUnderlineBackground(dark ? '#848484' : '#949494')

  return EditorView.theme(
    {
      '.cm-lintRange': {
        backgroundPosition: 'left bottom',
        backgroundRepeat: 'repeat-x',
        paddingBottom: '0.7px',
        textDecoration: 'none',
      },
      '.cm-lintRange-error': {
        backgroundImage: errorUnderline,
      },
      '.cm-lintRange-warning': {
        backgroundImage: warningUnderline,
      },
      '.cm-lintRange-info': {
        backgroundImage: hintUnderline,
      },
      '.cm-lintRange-hint': {
        backgroundImage: hintUnderline,
      },
      '.cm-lintRange.cm-workbenchUnusedVariable': {
        backgroundImage: 'none',
      },
      '.cm-lintRange.cm-workbenchErrorIdentifier': {
        backgroundImage: errorUnderline,
      },
      '.cm-lintRange.cm-workbenchErrorIdentifier, .cm-lintRange.cm-workbenchErrorIdentifier *': {
        color: 'var(--workbench-editor-diagnostic-error-fg, #8b0000) !important',
      },
      '.cm-line .cm-workbenchErrorIdentifier, .cm-line .cm-workbenchErrorIdentifier *': {
        color: 'var(--workbench-editor-diagnostic-error-fg, #8b0000) !important',
      },
      '.cm-lintRange.cm-workbenchUnusedVariable, .cm-lintRange.cm-workbenchUnusedVariable *': {
        color: 'var(--workbench-editor-unused-fg, #6e7681) !important',
        textDecoration: 'none !important',
      },
      '.cm-line .cm-workbenchUnusedVariable, .cm-line .cm-workbenchUnusedVariable *': {
        color: 'var(--workbench-editor-unused-fg, #6e7681) !important',
        textDecoration: 'none !important',
      },
    },
    { dark }
  )
}

export function getWorkbenchCodeMirrorTheme(theme: WorkbenchThemeId): Extension {
  switch (theme) {
    case 'warm-paper':
      return workbenchCodeMirrorWarmPaperTheme
    case 'midnight-blue':
      return workbenchCodeMirrorMidnightBlueTheme
    case 'dark-modern':
      return workbenchCodeMirrorDarculaTheme
    default:
      return workbenchCodeMirrorRiderTheme
  }
}
