import { readFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const defaultNotesPath = path.join(repoRoot, 'resources/release-notes/workbench.json')

function readLocalizedField(value, label, { items = false, allowEmpty = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain both zh and en`)
  }
  const normalized = {}
  for (const locale of ['zh', 'en']) {
    const field = value[locale]
    if (items) {
      if (!Array.isArray(field) || (!allowEmpty && field.length === 0) || field.length > 12) {
        throw new Error(`${label}.${locale} has an invalid item count`)
      }
      normalized[locale] = field.map((item) => {
        if (typeof item !== 'string' || !item.trim() || item.trim().length > 320) {
          throw new Error(`${label}.${locale} contains invalid text`)
        }
        return item.trim()
      })
      continue
    }
    if (typeof field !== 'string' || !field.trim() || field.trim().length > 160) {
      throw new Error(`${label}.${locale} contains invalid text`)
    }
    normalized[locale] = field.trim()
  }
  return normalized
}

export function validateWorkbenchReleaseNote(value, expectedVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Workbench v${expectedVersion} is missing release notes`)
  }
  if (value.softwareProduct !== undefined && value.softwareProduct !== 'workbench') {
    throw new Error(`Workbench v${expectedVersion} release notes target the wrong product`)
  }
  if (value.version !== expectedVersion) {
    throw new Error(
      `Workbench release notes version ${String(value.version)} must equal ${expectedVersion}`
    )
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value.releasedAt ?? '')) {
    throw new Error(`Workbench v${expectedVersion} releasedAt must use YYYY-MM-DD`)
  }
  const note = {
    softwareProduct: 'workbench',
    version: expectedVersion,
    releasedAt: value.releasedAt,
    title: readLocalizedField(value.title, `Workbench v${expectedVersion} title`),
    added: readLocalizedField(value.added, `Workbench v${expectedVersion} added`, {
      items: true,
      allowEmpty: true,
    }),
    fixed: readLocalizedField(value.fixed, `Workbench v${expectedVersion} fixed`, {
      items: true,
      allowEmpty: true,
    }),
  }
  if (note.added.zh.length + note.fixed.zh.length === 0) {
    throw new Error(`Workbench v${expectedVersion} needs at least one added or fixed item`)
  }
  if (
    note.added.zh.length !== note.added.en.length ||
    note.fixed.zh.length !== note.fixed.en.length
  ) {
    throw new Error(`Workbench v${expectedVersion} release-note locales must stay aligned`)
  }
  return note
}

export async function loadWorkbenchReleaseNote(version, notesPath = defaultNotesPath) {
  const document = JSON.parse(await readFile(notesPath, 'utf8'))
  if (
    document?.schemaVersion !== 1 ||
    document.product !== 'VelarOS Workbench' ||
    !Array.isArray(document.releases)
  ) {
    throw new Error(`Workbench release notes document is invalid: ${notesPath}`)
  }
  const matches = document.releases.filter((release) => release?.version === version)
  if (matches.length !== 1) {
    throw new Error(`Workbench v${version} must have exactly one release note`)
  }
  return validateWorkbenchReleaseNote(matches[0], version)
}

export { defaultNotesPath as defaultWorkbenchReleaseNotesPath }
