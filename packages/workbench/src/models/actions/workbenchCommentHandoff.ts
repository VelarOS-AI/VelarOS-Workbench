import type { AppLocale } from '../../contracts/index'
import {
  formatWorkbenchCommentLocation,
  type WorkbenchComment,
} from '../comments/workbenchCommentStore'

const COMMENT_SNIPPET_LIMIT = 2000

function truncateSnippet(snippet: string): string {
  if (snippet.length <= COMMENT_SNIPPET_LIMIT) return snippet
  return `${snippet.slice(0, COMMENT_SNIPPET_LIMIT)}\n…`
}

function buildSingleCommentBlock(comment: WorkbenchComment, locale: AppLocale): string {
  const fence = (comment.language || 'text').toLowerCase()
  const snippet = truncateSnippet(comment.snippet.replace(/\s+$/, ''))
  const location = formatWorkbenchCommentLocation(comment)

  if (locale === 'zh-CN')
    return `针对 \`${location}\` 的评论：

\`\`\`${fence}
${snippet}
\`\`\`

评论：${comment.body}`

  return `Comment on \`${location}\`:

\`\`\`${fence}
${snippet}
\`\`\`

Comment: ${comment.body}`
}

/**
 * 把选中的一批行内评论组装成随消息发送的上下文块（一条评论一个代码围栏 + 正文），
 * 供 composer 发送时前置到用户输入之前。
 */
export function buildWorkbenchCommentsContext(
  comments: readonly WorkbenchComment[],
  locale: AppLocale
): string {
  return comments.map((comment) => buildSingleCommentBlock(comment, locale)).join('\n\n')
}
