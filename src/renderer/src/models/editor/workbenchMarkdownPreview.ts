const MarkdownPreviewExtensions = new Set(['md', 'markdown', 'mdown'])
const ExternalLinkSchemes = new Set(['http:', 'https:', 'mailto:'])

export type WorkbenchMarkdownLink =
  | { kind: 'blocked' }
  | { kind: 'external'; url: string }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'project'; path: string; fragment?: string }

export function isWorkbenchMarkdownPreviewPath(path: Nullable<string>): boolean {
  const extension = path?.split('.').at(-1)?.toLowerCase() ?? ''
  return MarkdownPreviewExtensions.has(extension)
}

function normalizeProjectPath(path: string): Nullable<string> {
  const segments: string[] = []
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.join('/') || null
}

export function resolveWorkbenchMarkdownLink(
  currentPath: string,
  href: string
): WorkbenchMarkdownLink {
  const value = href.trim()
  if (!value) return { kind: 'blocked' }
  if (value.startsWith('#')) return { kind: 'fragment', fragment: value.slice(1) }

  const scheme = value.match(/^[A-Za-z][A-Za-z\d+.-]*:/u)?.[0]?.toLowerCase()
  if (scheme) return ExternalLinkSchemes.has(scheme)
      ? { kind: 'external', url: value }
      : { kind: 'blocked' }
  if (value.startsWith('//')) return { kind: 'blocked' }

  const [pathWithQuery, fragment] = value.split('#', 2)
  const pathValue = pathWithQuery.split('?', 1)[0]
  const currentDirectory = currentPath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
  const targetPath = normalizeProjectPath(
    pathValue.startsWith('/') ? pathValue.slice(1) : `${currentDirectory}/${pathValue}`
  )
  if (!targetPath) return { kind: 'blocked' }

  return fragment
    ? { kind: 'project', path: targetPath, fragment }
    : { kind: 'project', path: targetPath }
}
