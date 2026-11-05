import type { Extension } from '@codemirror/state'

import { toNullable } from '@velaros-ai/velaros/core'

export interface WorkbenchBasicSyntaxContribution {
  readonly keywords: readonly string[]
  readonly lineComment: string
}

export interface WorkbenchProjectCommandContribution {
  readonly id: string
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
}

export interface WorkbenchProjectLanguageContribution {
  readonly markers: readonly string[]
  readonly commands: readonly WorkbenchProjectCommandContribution[]
}

/** Renderer-side contribution injected by a built-in language package. */
export interface WorkbenchEditorLanguageContribution {
  readonly id: string
  readonly languageId: string
  readonly extensions: readonly string[]
  readonly languages: readonly string[]
  readonly createExtension: () => Extension
  readonly basicSyntax?: WorkbenchBasicSyntaxContribution
  readonly project?: WorkbenchProjectLanguageContribution
}

const Contributions = new Map<string, WorkbenchEditorLanguageContribution>()

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function matches(contribution: WorkbenchEditorLanguageContribution, token: string): boolean {
  const normalized = normalize(token)
  return contribution.extensions.includes(normalized) || contribution.languages.includes(normalized)
}

export function registerWorkbenchEditorLanguage(
  contribution: WorkbenchEditorLanguageContribution
): () => void {
  const current = Contributions.get(contribution.id)
  if (current && current !== contribution)
    throw new Error(`Workbench editor language '${contribution.id}' is already registered`)
  Contributions.set(contribution.id, contribution)
  return () => {
    if (Contributions.get(contribution.id) === contribution) Contributions.delete(contribution.id)
  }
}

export function resolveWorkbenchEditorLanguage(
  token: string
): Nullable<WorkbenchEditorLanguageContribution> {
  if (!token) return null
  return toNullable([...Contributions.values()].find((item) => matches(item, token)))
}

export function getInjectedWorkbenchEditorLanguages(): readonly WorkbenchEditorLanguageContribution[] {
  return [...Contributions.values()]
}

export function resolveInjectedWorkbenchProjectLanguages(
  rootEntries: readonly string[]
): readonly WorkbenchEditorLanguageContribution[] {
  const names = new Set(rootEntries.map(normalize))
  return [...Contributions.values()].filter((item) =>
    item.project?.markers.some((marker) => names.has(normalize(marker)))
  )
}
