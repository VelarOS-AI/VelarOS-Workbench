import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

import {
  isWorkbenchDarkTheme,
  type WorkbenchThemeId,
} from '../settings/workbenchPreferences'

const riderLightHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.self,
    ],
    color: '#0033b3',
  },
  {
    tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator],
    color: '#000000',
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
    color: '#067d17',
  },
  {
    tag: [tags.escape, tags.regexp],
    color: '#055f12',
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
    color: '#1750eb',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: '#707070',
    fontStyle: 'italic',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: '#795e26',
  },
  {
    tag: tags.special(tags.definition(tags.variableName)),
    color: '#9c27b0',
  },
  {
    tag: [
      tags.className,
      tags.typeName,
      tags.tagName,
      tags.namespace,
      tags.definition(tags.typeName),
    ],
    color: '#007070',
  },
  {
    tag: [tags.propertyName, tags.attributeName],
    color: '#871094',
  },
  {
    tag: tags.monospace,
    color: '#a04b00',
  },
  {
    tag: [tags.variableName, tags.name],
    color: '#000000',
  },
  {
    tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.macroName],
    color: '#808000',
  },
  {
    tag: [tags.heading, tags.strong],
    color: '#0033b3',
    fontWeight: '600',
  },
  {
    tag: [tags.link, tags.url],
    color: '#2456b3',
    textDecoration: 'underline',
  },
  {
    tag: tags.invalid,
    color: '#bc3f3c',
    textDecoration: 'underline wavy #bc3f3c',
  },
])

export const workbenchCodeMirrorRiderTheme: Extension = syntaxHighlighting(riderLightHighlightStyle)

const warmPaperHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.self,
    ],
    color: '#7c3aed',
  },
  {
    tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator],
    color: '#5b4635',
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
    color: '#557a1f',
  },
  { tag: [tags.escape, tags.regexp], color: '#2f7d4f' },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
    color: '#b45309',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: '#998773',
    fontStyle: 'italic',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: '#8b5e1a',
  },
  {
    tag: tags.special(tags.definition(tags.variableName)),
    color: '#be185d',
  },
  {
    tag: [
      tags.className,
      tags.typeName,
      tags.tagName,
      tags.namespace,
      tags.definition(tags.typeName),
    ],
    color: '#0f766e',
  },
  { tag: [tags.propertyName, tags.attributeName], color: '#9d174d' },
  { tag: tags.monospace, color: '#8b5e1a' },
  { tag: [tags.variableName, tags.name], color: '#3d3025' },
  {
    tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.macroName],
    color: '#a16207',
  },
  { tag: [tags.heading, tags.strong], color: '#7c3aed', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: '#0369a1', textDecoration: 'underline' },
  {
    tag: tags.invalid,
    color: '#b91c1c',
    textDecoration: 'underline wavy #b91c1c',
  },
])

const workbenchCodeMirrorWarmPaperTheme: Extension = syntaxHighlighting(warmPaperHighlightStyle)

const riderDarkHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.self,
    ],
    color: '#cf8efa',
  },
  {
    tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator],
    color: '#bfc7d5',
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
    color: '#6aab73',
  },
  {
    tag: [tags.escape, tags.regexp],
    color: '#7dd38d',
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
    color: '#2aacb8',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: '#7a808b',
    fontStyle: 'italic',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: '#dcdcaa',
  },
  {
    tag: tags.special(tags.definition(tags.variableName)),
    color: '#d16d9e',
  },
  {
    tag: [
      tags.className,
      tags.typeName,
      tags.tagName,
      tags.namespace,
      tags.definition(tags.typeName),
    ],
    color: '#56c3d6',
  },
  {
    tag: [tags.propertyName, tags.attributeName],
    color: '#bababa',
  },
  {
    tag: tags.monospace,
    color: '#ce9178',
  },
  {
    tag: [tags.variableName, tags.name],
    color: '#d8dee9',
  },
  {
    tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.macroName],
    color: '#c8a56c',
  },
  {
    tag: [tags.heading, tags.strong],
    color: '#8ab4f8',
    fontWeight: '600',
  },
  {
    tag: [tags.link, tags.url],
    color: '#6aa8ff',
    textDecoration: 'underline',
  },
  {
    tag: tags.invalid,
    color: '#ff7373',
    textDecoration: 'underline wavy #ff7373',
  },
])

const workbenchCodeMirrorDarculaTheme: Extension = syntaxHighlighting(riderDarkHighlightStyle)

const midnightBlueHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.self,
    ],
    color: '#c792ea',
  },
  {
    tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator],
    color: '#89ddff',
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
    color: '#addb67',
  },
  { tag: [tags.escape, tags.regexp], color: '#c3e88d' },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
    color: '#f78c6c',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: '#637777',
    fontStyle: 'italic',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: '#82aaff',
  },
  {
    tag: tags.special(tags.definition(tags.variableName)),
    color: '#ffcb6b',
  },
  {
    tag: [
      tags.className,
      tags.typeName,
      tags.tagName,
      tags.namespace,
      tags.definition(tags.typeName),
    ],
    color: '#89ddff',
  },
  { tag: [tags.propertyName, tags.attributeName], color: '#f07178' },
  { tag: tags.monospace, color: '#f78c6c' },
  { tag: [tags.variableName, tags.name], color: '#d6deeb' },
  {
    tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.macroName],
    color: '#ffcb6b',
  },
  { tag: [tags.heading, tags.strong], color: '#82aaff', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: '#80cbc4', textDecoration: 'underline' },
  {
    tag: tags.invalid,
    color: '#ff5370',
    textDecoration: 'underline wavy #ff5370',
  },
])

const workbenchCodeMirrorMidnightBlueTheme: Extension = syntaxHighlighting(
  midnightBlueHighlightStyle
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
