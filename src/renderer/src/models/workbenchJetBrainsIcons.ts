const iconUrls = new Map<string, string>()

export function getWorkbenchJetBrainsIcon(name: string, dark: boolean): string {
  const asset = dark ? `${name}_dark` : name
  const cached = iconUrls.get(asset)
  if (cached) return cached
  const url = new URL(`../assets/jetbrains-icons/${asset}.svg?no-inline`, import.meta.url).href
  iconUrls.set(asset, url)
  return url
}

const FileIcons: Record<string, string> = {
  c: 'c',
  cpp: 'cpp',
  csharp: 'Csharp',
  css: 'css',
  html: 'html',
  java: 'java',
  less: 'css',
  python: 'python',
  sass: 'css',
  scss: 'css',
  shell: 'shell',
  sql: 'sql',
  swift: 'swiftLang',
  vue: 'vue',
  webassembly: 'binaryData',
}

const FileNames: Record<string, string> = { dockerfile: 'docker', 'dockerfile.dev': 'docker' }
const FileExtensions: Record<string, string> = {
  bat: 'microsoftWindows',
  cmd: 'microsoftWindows',
  gradle: 'gradle',
  graphql: 'graphql',
  gql: 'graphql',
  ipynb: 'jupyter',
  properties: 'properties',
  toml: 'toml',
  xml: 'xml',
}

export function getWorkbenchJetBrainsFileIcon(fileName: string, variant: string | null): string | null {
  const name = fileName.toLowerCase()
  const ext = name.slice(name.lastIndexOf('.') + 1)
  const icon = (Object.hasOwn(FileNames, name) ? FileNames[name] : undefined) ??
    (Object.hasOwn(FileExtensions, ext) ? FileExtensions[ext] : undefined) ??
    (variant && Object.hasOwn(FileIcons, variant) ? FileIcons[variant] : undefined)
  return icon ? `file-${icon}` : null
}
