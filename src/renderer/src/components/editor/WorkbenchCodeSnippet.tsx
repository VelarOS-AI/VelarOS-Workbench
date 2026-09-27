import { type ReactElement, useMemo } from 'react'
import { useWorkbenchCodeTheme } from '@renderer/hooks/useWorkbenchPreferences'
import { highlightWorkbenchCodeSnippet } from '@renderer/models/editor/workbenchCodeSnippetHighlight'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import styles from '../../styles/workbenchPageStyles'

/** 搜索结果里的一行代码：按文件的语言着色（与编辑器同一套颜色），查询词加底色标出。 */
export function WorkbenchCodeSnippet({
  path,
  text,
  query,
  className,
}: {
  path: string
  text: string
  query?: string
  className?: string
}): ReactElement {
  const theme = useWorkbenchCodeTheme()
  const tokens = useMemo(
    () => highlightWorkbenchCodeSnippet({ path, text, theme, query }),
    [path, query, text, theme]
  )

  return (
    <Text truncate className={className}>
      {tokens.map((token, index) =>
        token.match ? (
          <mark key={index} className={styles.codeSnippetMatch} style={token.style}>
            {token.text}
          </mark>
        ) : (
          <span key={index} style={token.style}>
            {token.text}
          </span>
        )
      )}
    </Text>
  )
}
