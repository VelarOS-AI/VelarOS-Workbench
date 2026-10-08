/**
 * Workbench 页样式入口，按界面区域分为 15 段。
 *
 * 两条铁律：
 * 1. 导入顺序决定级联顺序，主题覆写段 15-overrides 必须最后；
 * 2. 段文件是 CSS Modules，但应用 vite 配置了固定 `generateScopedName`（`wb_[local]`），
 *    跨段选择器（如 01-shell 的主题块引用编辑器类）因此命中同一产物类名——改回哈希式
 *    scoped name 会瞬间打断跨段级联，禁止。
 *
 * 消费方通过默认导出的合并映射读取类名。
 */
import shell from './01-shell.module.css'
import chromeTop from './02-chrome-top.module.css'
import layout from './03-layout.module.css'
import insightChat from './04-insight-chat.module.css'
import git from './05-git.module.css'
import aiCommit from './06-ai-commit.module.css'
import statusDialogs from './07-status-dialogs.module.css'
import files from './08-files.module.css'
import editor from './09-editor.module.css'
import history from './10-history.module.css'
import editorTooltips from './11-editor-tooltips.module.css'
import actionsTerminal from './12-actions-terminal.module.css'
import quickOpen from './13-quickopen.module.css'
import settings from './14-settings.module.css'
import overrides from './15-overrides.module.css'

const workbenchPageStyles: Record<string, string> = {
  ...shell,
  ...chromeTop,
  ...layout,
  ...insightChat,
  ...git,
  ...aiCommit,
  ...statusDialogs,
  ...files,
  ...editor,
  ...history,
  ...editorTooltips,
  ...actionsTerminal,
  ...quickOpen,
  ...settings,
  ...overrides,
}

export default workbenchPageStyles
