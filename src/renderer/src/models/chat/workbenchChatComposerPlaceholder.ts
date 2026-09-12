type WorkbenchChatComposerPlaceholderTranslate = (
  key: 'workbench.chatAskAboutFile' | 'workbench.chatPlaceholder',
  params?: { path: string }
) => string

/**
 * 输入框提示跟着「当前文件」chip 走：chip 在，就提示问这个文件；用户取消了 chip，提示回到通用的
 * 「向 Workbench Agent 提问…」；换打开别的文件、chip 重新出现时提示也跟着回来。
 */
export function resolveWorkbenchChatComposerPlaceholder(
  includedCurrentFilePath: Nullable<string>,
  t: WorkbenchChatComposerPlaceholderTranslate
): string {
  return includedCurrentFilePath
    ? t('workbench.chatAskAboutFile', { path: includedCurrentFilePath })
    : t('workbench.chatPlaceholder')
}
