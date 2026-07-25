import { toNullable } from '@velaros-ai/core'

import {
  getPluginWorkbenchLanguageServices,
  getWorkbenchPathExtension,
  resolvePluginWorkbenchLanguageService,
  type WorkbenchLanguageServiceDescriptor,
} from '../../language/workbenchLanguageServices'

export interface WorkbenchLanguagePluginDescriptor {
  id: string
  label: string
  packageName: string
  extensions: string[]
  languages: string[]
  service: WorkbenchLanguageServiceDescriptor
}

export interface WorkbenchLanguagePluginRecommendation {
  plugin: WorkbenchLanguagePluginDescriptor
  matchedFileCount: number
  selectedFileMatched: boolean
  samplePaths: string[]
}

interface WorkbenchLanguagePluginRecommendationInput {
  files: Array<{ path: string; language?: string }>
  selectedPath?: LooseOptional<string>
  limit?: number
}

const DownloadableLanguagePlugins: WorkbenchLanguagePluginDescriptor[] =
  getPluginWorkbenchLanguageServices().map((service) => ({
    id: service.id,
    label: service.label,
    packageName: service.packageName ?? `@velaros-ai/workbench-language-${service.id}`,
    extensions: service.extensions,
    languages: service.languages,
    service,
  }))

export function resolveDownloadableWorkbenchLanguagePlugin(
  token: string
): Nullable<WorkbenchLanguagePluginDescriptor> {
  if (!token) return null

  return (
    toNullable(DownloadableLanguagePlugins.find(
      (plugin) => plugin.id === resolvePluginWorkbenchLanguageService(token)?.id
    ))
  )
}

function pathMatchesPlugin(path: string, plugin: WorkbenchLanguagePluginDescriptor): boolean {
  const extension = getWorkbenchPathExtension(path)
  return !!extension && plugin.extensions.includes(extension)
}

export function getDownloadableWorkbenchLanguagePlugins(): readonly WorkbenchLanguagePluginDescriptor[] {
  return DownloadableLanguagePlugins
}

export function recommendWorkbenchLanguagePlugins({
  files,
  selectedPath = null,
  limit = 4,
}: WorkbenchLanguagePluginRecommendationInput): WorkbenchLanguagePluginRecommendation[] {
  const recommendations = DownloadableLanguagePlugins.map((plugin) => {
    const matchedPaths = files
      .map((file) => file.path)
      .filter((path) => pathMatchesPlugin(path, plugin))

    return {
      plugin,
      matchedFileCount: matchedPaths.length,
      selectedFileMatched: selectedPath ? pathMatchesPlugin(selectedPath, plugin) : false,
      samplePaths: matchedPaths.slice(0, 3),
    } satisfies WorkbenchLanguagePluginRecommendation
  })

  return recommendations
    .filter(
      (recommendation) => recommendation.matchedFileCount > 0 || recommendation.selectedFileMatched
    )
    .sort(
      (left, right) =>
        +right.selectedFileMatched - +left.selectedFileMatched ||
        right.matchedFileCount - left.matchedFileCount ||
        left.plugin.label.localeCompare(right.plugin.label)
    )
    .slice(0, Math.max(0, limit))
}
