/** 与 Desktop 一样优先用派发任务首行作标题，完整说明留在展开详情。 */
export function workbenchWorkerTaskTitle(task: string): string {
  const firstLine =
    task
      .trim()
      .split(/\r?\n/)[0]
      ?.replace(/^#{1,6}\s+/, '')
      .trim() ?? ''
  const title = firstLine
    .replace(/^你负责\s*/u, '')
    .split(/[。！？；，]/u)[0]!
    .trim()
  if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(title)) return ''
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}
