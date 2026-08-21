import { type BrowserWindow, dialog } from 'electron'

/** 系统目录选择器只负责取路径；窗口归属与打开策略由 WorkbenchWindowManager 决定。 */
export async function pickDirectory(
  parent: Nullable<BrowserWindow>,
  title: string
): Promise<Nullable<string>> {
  const options = {
    title,
    properties: ['openDirectory', 'createDirectory'],
  } satisfies Electron.OpenDialogOptions

  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  const picked = result.filePaths[0]
  return result.canceled || !picked ? null : picked
}
