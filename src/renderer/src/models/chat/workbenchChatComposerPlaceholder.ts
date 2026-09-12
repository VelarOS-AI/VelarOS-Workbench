type WorkbenchChatComposerPlaceholderTranslate = (
  key: 'workbench.chatAskAboutFile' | 'workbench.chatAskAboutFiles' | 'workbench.chatPlaceholder',
  params?: { path: string } | { count: number }
) => string

/**
 * 输入框提示跟着这条消息要问的文件走：「当前文件」chip 加上右键「添加到聊天」挂上的文件。只有一个就提示问
 * 这个文件，挂了好几个就说问几个文件；chip 全部取消后回到通用的「向 Workbench Agent 提问…」，换打开别的
 * 文件、「当前文件」chip 重新出现时提示也跟着回来。
 */
export function resolveWorkbenchChatComposerPlaceholder(
  askedFilePaths: readonly string[],
  t: WorkbenchChatComposerPlaceholderTranslate
): string {
  if (askedFilePaths.length > 1)
    return t('workbench.chatAskAboutFiles', { count: askedFilePaths.length })

  const [path] = askedFilePaths
  return path ? t('workbench.chatAskAboutFile', { path }) : t('workbench.chatPlaceholder')
}
