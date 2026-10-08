import { useEffect, useState } from 'react'

import { useWorkbenchHostRuntime } from '../host/WorkbenchHostProvider'

/** 当前文件在 HEAD 里的全文：编辑区 Git 改动标记的对照基准。 */
export interface WorkbenchGitHeadContent {
  path: string
  /** null：HEAD 里没有这个文件（新文件、未跟踪），或者读不到。 */
  content: Nullable<string>
}

interface WorkbenchGitHeadContentState extends WorkbenchGitHeadContent {
  projectRoot: string
}

/**
 * 读当前文件在 HEAD 里的全文。`revision` 是版本库状态的刷新序号：提交、切分支、拉取之后 HEAD 可能变了，
 * 它一变就重读；为 null 表示项目不是 Git 仓库，不读。结果带着它属于哪个文件，切文件时上一个文件的
 * 不会被拿去跟新文件比。
 */
export function useWorkbenchGitHeadContent({
  projectRoot,
  path,
  revision,
}: {
  projectRoot: string
  path: Nullable<string>
  revision: Nullable<number>
}): Nullable<WorkbenchGitHeadContent> {
  const hostRuntime = useWorkbenchHostRuntime()
  const [headContent, setHeadContent] = useState<Nullable<WorkbenchGitHeadContentState>>(null)

  useEffect(() => {
    if (!path || revision === null) return undefined

    let cancelled = false
    void hostRuntime.kernel.workspace
      .getWorkspaceGitFileAtCommit(projectRoot, { commitSha: 'HEAD', path })
      .then(
        (result) => (result.ok ? result.data.content : null),
        () => null
      )
      .then((content) => {
        if (cancelled) return
        // HEAD 没动时重读回来的是同一份：沿用原对象，编辑器不必重比。
        setHeadContent((current) =>
          current?.projectRoot === projectRoot &&
          current.path === path &&
          current.content === content
            ? current
            : { projectRoot, path, content }
        )
      })
    return () => {
      cancelled = true
    }
  }, [hostRuntime, path, projectRoot, revision])

  return headContent &&
    revision !== null &&
    headContent.projectRoot === projectRoot &&
    headContent.path === path
    ? headContent
    : null
}
