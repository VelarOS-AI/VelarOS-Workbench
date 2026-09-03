export const WorkbenchImageMediaTypes = [
  'image/png',
  'image/svg+xml',
  'image/webp',
] as const

export type WorkbenchImageMediaType = (typeof WorkbenchImageMediaTypes)[number]

const ImageMediaTypeByExtension: Readonly<Record<string, WorkbenchImageMediaType>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

function fileExtension(path: string): string {
  const name = path.split(/[/\\]/u).at(-1) ?? ''
  const separator = name.lastIndexOf('.')
  return separator >= 0 ? name.slice(separator + 1).toLowerCase() : ''
}

export function resolveWorkbenchImageMediaType(
  path: string,
  mediaType = ''
): WorkbenchImageMediaType | null {
  const extensionType = ImageMediaTypeByExtension[fileExtension(path)]
  if (extensionType) return extensionType

  const normalizedMediaType = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return WorkbenchImageMediaTypes.find((value) => value === normalizedMediaType) ?? null
}

export function isWorkbenchImagePreviewPath(path: string): boolean {
  return resolveWorkbenchImageMediaType(path) !== null
}
