import type { ChatInputMentionableOption } from '@velaros-ai/ui/conversation/composer'

/**
 * 聊天输入框里的文件引用：用户在编辑器、标签页或文件树里右键「添加到聊天」挂上的文件，可以一次挂好几个。
 *
 * 引用只是锚点——发给 Agent 的是项目内相对路径，不是文件内容；要不要读、读哪一段，由 Agent 自己用项目工具
 * 决定。这样挂上一串大文件也不会把上下文撑爆，Agent 读到的也总是磁盘上的最新内容。
 *
 * 输入框里借用 composer 的「可引用项」通道：挂上的文件以 chip 显示；在输入框里敲 `@` 能从本会话挂过的
 * 文件里重新选。
 */

const WorkbenchChatFileReferenceIdPrefix = 'workbench-file:'

export function workbenchChatFileReferenceId(path: string): string {
  return `${WorkbenchChatFileReferenceIdPrefix}${path}`
}

export function readWorkbenchChatFileReferencePath(id: string): Nullable<string> {
  return id.startsWith(WorkbenchChatFileReferenceIdPrefix)
    ? id.slice(WorkbenchChatFileReferenceIdPrefix.length)
    : null
}

/** 追加引用：已经在的不重复加，保持先来后到。 */
export function appendWorkbenchChatFileReferences(
  current: readonly string[],
  incoming: readonly string[]
): string[] {
  const next = [...current]
  for (const path of incoming) {
    if (path && !next.includes(path)) next.push(path)
  }
  return next
}

function pathSegments(path: string): string[] {
  return path.replace(/\\/gu, '/').split('/').filter(Boolean)
}

function pathSuffix(segments: readonly string[], depth: number): string {
  return segments.slice(-depth).join('/')
}

/**
 * 可引用项列表。chip 上只写文件名；同名文件同时挂着时（几个 `index.ts`）往上补目录，直到彼此能区分。
 * 正文放完整的相对路径：`@` 列表里作说明，chip 悬停时也看得到。
 */
export function buildWorkbenchChatFileReferenceOptions(
  paths: readonly string[]
): ChatInputMentionableOption[] {
  const segmentsByPath = paths.map((path) => ({ path, segments: pathSegments(path) }))

  return segmentsByPath.map(({ path, segments }) => {
    const others = segmentsByPath.filter((entry) => entry.path !== path)
    let depth = 1
    while (
      depth < segments.length
      && others.some((other) => pathSuffix(other.segments, depth) === pathSuffix(segments, depth))
    ) depth += 1

    return {
      id: workbenchChatFileReferenceId(path),
      label: pathSuffix(segments, depth) || path,
      body: path,
    }
  })
}

/** 发给模型的锚点段：只有路径，并说明内容没有附上、需要时自己去读。 */
export function formatWorkbenchChatFileReferencesForPrompt(paths: readonly string[]): string {
  if (paths.length === 0) return ''

  return [
    'Files the user referenced in the Workbench (paths only; their contents are not included, read them yourself as needed):',
    ...paths.map((path) => `- ${path}`),
  ].join('\n')
}
