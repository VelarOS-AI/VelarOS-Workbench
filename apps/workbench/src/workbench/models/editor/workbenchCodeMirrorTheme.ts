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
    tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword],
    color: '#0033b3',
  },
  {
    tag: [tags.operatorKeyword, tags.operator, tags.derefOperator, tags.arithmeticOperator],
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
    tag: [tags.variableName, tags.name, tags.self],
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

const riderDarkHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword],
    color: '#cf8efa',
  },
  {
    tag: [tags.operatorKeyword, tags.operator, tags.derefOperator, tags.arithmeticOperator],
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
    tag: [tags.variableName, tags.name, tags.self],
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

export const workbenchCodeMirrorLintTheme: Extension = EditorView.theme(
  {
    '.cm-lintRange': {
      backgroundImage: 'none',
      paddingBottom: '0',
      textUnderlineOffset: '2px',
    },
    '.cm-lintRange-error': {
      textDecoration: 'underline wavy var(--workbench-editor-diagnostic-error-underline)',
    },
    '.cm-lintRange-warning': {
      textDecoration: 'underline wavy var(--workbench-editor-diagnostic-warning-underline)',
    },
    '.cm-lintRange-info': {
      textDecoration: 'underline wavy var(--workbench-editor-diagnostic-hint-underline)',
    },
    '.cm-lintRange-hint': {
      textDecoration: 'underline wavy var(--workbench-editor-diagnostic-hint-underline)',
    },
    '.cm-lintRange.cm-workbenchUnusedVariable': {
      textDecoration: 'none',
      backgroundImage: 'none',
    },
    '.cm-lintRange.cm-workbenchErrorIdentifier': {
      textDecoration: 'underline wavy var(--workbench-editor-diagnostic-error-underline)',
      backgroundImage: 'none',
    },
    '.cm-lintRange.cm-workbenchErrorIdentifier, .cm-lintRange.cm-workbenchErrorIdentifier *': {
      color: 'var(--workbench-editor-diagnostic-error-fg, #8b0000) !important',
    },
    '.cm-line .cm-workbenchErrorIdentifier, .cm-line .cm-workbenchErrorIdentifier *': {
      color: 'var(--workbench-editor-diagnostic-error-fg, #8b0000) !important',
      textDecoration: 'underline wavy var(--workbench-editor-diagnostic-error-underline)',
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
  { dark: false }
)

export function getWorkbenchCodeMirrorTheme(theme: WorkbenchThemeId): Extension {
  return isWorkbenchDarkTheme(theme) ? workbenchCodeMirrorDarculaTheme : workbenchCodeMirrorRiderTheme
}
