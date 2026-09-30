import { Fragment, type ReactElement, useMemo } from 'react'
import { useWorkbenchCodeTheme } from '@renderer/hooks/useWorkbenchPreferences'
import { highlightWorkbenchCodeSnippet } from '@renderer/models/editor/workbenchCodeSnippetHighlight'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import styles from '../../styles/workbenchPageStyles'

/**
 * 搜索结果里的一行代码：按文件的语言着色（与编辑器同一套颜色），匹配加底色标出——给了 `match` 标它指的那一段，
 * 否则标查询词。给了 `replacement` 时预览替换：匹配划掉，后面跟着要换成的文字。
 */
export function WorkbenchCodeSnippet({
  path,
  text,
  query,
  match,
  replacement,
  className,
}: {
  path: string
  text: string
  query?: string
  match?: { start: number; end: number }
  replacement?: string
  className?: string
}): ReactElement {
  const theme = useWorkbenchCodeTheme()
  const matchStart = match?.start
  const matchEnd = match?.end
  const tokens = useMemo(
    () =>
      highlightWorkbenchCodeSnippet({
        path,
        text,
        theme,
        query,
        match:
          matchStart !== undefined && matchEnd !== undefined
            ? { start: matchStart, end: matchEnd }
            : undefined,
      }),
    [matchEnd, matchStart, path, query, text, theme]
  )
  const replacing = replacement !== undefined
  const lastMatchIndex = replacing ? tokens.findLastIndex((token) => token.match) : -1

  return (
    <Text truncate className={className}>
      {tokens.map((token, index) => (
        <Fragment key={index}>
          {token.match ? (
            <mark
              className={styles.codeSnippetMatch}
              data-replaced={replacing || undefined}
              style={token.style}
            >
              {token.text}
            </mark>
          ) : (
            <span style={token.style}>{token.text}</span>
          )}
          {index === lastMatchIndex && !!replacement && (
            <ins className={styles.codeSnippetReplacement}>{replacement}</ins>
          )}
        </Fragment>
      ))}
    </Text>
  )
}
