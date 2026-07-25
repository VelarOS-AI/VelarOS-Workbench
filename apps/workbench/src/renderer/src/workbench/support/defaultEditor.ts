/** 独立 Workbench 应用副本（desktop `@shared/constants/defaultEditor` 同源）。 */
import { isString } from '@velaros/core'
import type { SystemDefaultEditorId } from '@velaros/core/types'

export interface SystemDefaultEditorDefinition {
  id: SystemDefaultEditorId
  label: string
  darwinApplication?: string
  command?: string
}

export const SystemDefaultEditorSystemId = 'system' satisfies SystemDefaultEditorId
export const SystemDefaultEditorLightId = 'velaros-light' satisfies SystemDefaultEditorId

export const SystemDefaultEditorDefinitions = [
  {
    id: SystemDefaultEditorLightId,
    label: 'VelarOS Light',
  },
  {
    id: SystemDefaultEditorSystemId,
    label: 'System default',
  },
  {
    id: 'visual-studio-code',
    label: 'Visual Studio Code',
    darwinApplication: 'Visual Studio Code',
    command: 'code',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    darwinApplication: 'Cursor',
    command: 'cursor',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    darwinApplication: 'Windsurf',
    command: 'windsurf',
  },
  {
    id: 'trae',
    label: 'Trae',
    darwinApplication: 'Trae',
    command: 'trae',
  },
  {
    id: 'zed',
    label: 'Zed',
    darwinApplication: 'Zed',
    command: 'zed',
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    darwinApplication: 'WebStorm',
    command: 'webstorm',
  },
  {
    id: 'sublime-text',
    label: 'Sublime Text',
    darwinApplication: 'Sublime Text',
    command: 'subl',
  },
] as const satisfies readonly SystemDefaultEditorDefinition[]

const SystemDefaultEditorIdSet = new Set<string>(
  SystemDefaultEditorDefinitions.map((definition) => definition.id)
)

export function isSystemDefaultEditorId(value: any): value is SystemDefaultEditorId {
  return isString(value) && SystemDefaultEditorIdSet.has(value)
}

export function getSystemDefaultEditorDefinition(
  id: SystemDefaultEditorId
): SystemDefaultEditorDefinition {
  return (
    SystemDefaultEditorDefinitions.find((definition) => definition.id === id) ??
    SystemDefaultEditorDefinitions[0]
  )
}
