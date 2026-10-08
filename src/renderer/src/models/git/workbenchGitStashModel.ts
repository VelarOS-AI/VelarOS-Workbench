import { type WorkspaceGitStash } from '@shared/contracts/workspaceGit'

import { type WorkbenchI18nContextValue } from '../../i18n/WorkbenchLocalizationProvider'

type Translate = WorkbenchI18nContextValue['t']

/** 贮藏在列表里的名字：贮藏时写的说明；没写的叫「未命名的贮藏」。 */
export function getWorkbenchGitStashTitle(stash: WorkspaceGitStash, t: Translate): string {
  return stash.autoMessage || !stash.message ? t('workbench.gitStashUntitled') : stash.message
}

/**
 * 名字下面的一行：在哪个分支上贮藏的；没写说明的再带上它基于的提交（git 拟的说明就是那个提交），
 * 好跟别的未命名贮藏分开。
 */
export function getWorkbenchGitStashSubtitle(stash: WorkspaceGitStash, t: Translate): string {
  const origin = stash.branch
    ? t('workbench.gitStashOnBranch', { branch: stash.branch })
    : t('workbench.gitStashOnDetachedHead')
  return stash.autoMessage && stash.message
    ? `${origin} · ${t('workbench.gitStashBase', { commit: stash.message })}`
    : origin
}

/** 两次读到的贮藏列表一样（同样的贮藏、同样的顺序）：刷新时沿用原来的列表，界面不必重画。 */
export function isSameWorkbenchGitStashList(
  left: readonly WorkspaceGitStash[],
  right: readonly WorkspaceGitStash[]
): boolean {
  return (
    left.length === right.length &&
    left.every((stash, index) => stash.sha === right[index]?.sha && stash.index === right[index]?.index)
  )
}

/** 贮藏时默认连不连未跟踪的文件：只有未跟踪的文件可贮藏时默认连上，别的时候默认不动它们。 */
export function shouldWorkbenchGitStashIncludeUntrackedByDefault(counts: {
  tracked: number
  untracked: number
}): boolean {
  return counts.tracked === 0 && counts.untracked > 0
}
