import { type ReactElement, type ReactNode, useMemo } from 'react'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  highlightWorkbenchConsoleOutput,
  type WorkbenchConsoleOutputToken,
  type WorkbenchConsoleOutputTokenKind,
} from '@renderer/models/commands/workbenchConsoleOutputHighlight'

import styles from '../../styles/workbenchPageStyles'

const TOKEN_CLASS: Partial<Record<WorkbenchConsoleOutputTokenKind, string>> = {
  timestamp: styles.consoleTokenTimestamp,
  levelDbg: styles.consoleTokenLevelDbg,
  levelInfo: styles.consoleTokenLevelInfo,
  levelWarn: styles.consoleTokenLevelWarn,
  levelError: styles.consoleTokenLevelError,
  jsonKey: styles.consoleTokenJsonKey,
  string: styles.consoleTokenString,
  number: styles.consoleTokenNumber,
  boolean: styles.consoleTokenBoolean,
  stackFunction: styles.consoleTokenStackFunction,
  stackPath: styles.consoleTokenStackPath,
  ansiBlack: styles.consoleAnsiBlack,
  ansiRed: styles.consoleAnsiRed,
  ansiGreen: styles.consoleAnsiGreen,
  ansiYellow: styles.consoleAnsiYellow,
  ansiBlue: styles.consoleAnsiBlue,
  ansiMagenta: styles.consoleAnsiMagenta,
  ansiCyan: styles.consoleAnsiCyan,
  ansiWhite: styles.consoleAnsiWhite,
  ansiBrightBlack: styles.consoleAnsiBrightBlack,
  ansiBrightRed: styles.consoleAnsiBrightRed,
  ansiBrightGreen: styles.consoleAnsiBrightGreen,
  ansiBrightYellow: styles.consoleAnsiBrightYellow,
  ansiBrightBlue: styles.consoleAnsiBrightBlue,
  ansiBrightMagenta: styles.consoleAnsiBrightMagenta,
  ansiBrightCyan: styles.consoleAnsiBrightCyan,
  ansiBrightWhite: styles.consoleAnsiBrightWhite,
}
function openExternalUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

interface WorkbenchConsoleOutputLineProps {
  text: string
  className?: string
  stream?: string
  tokens?: readonly WorkbenchConsoleOutputToken[]
  /** 点击链接文字时的处理（默认走内置浏览器调试选项卡）；未提供则回退到系统外部浏览器。 */
  onOpenLink?: (url: string) => void
}

export function WorkbenchConsoleOutputLine({
  text,
  className,
  stream,
  tokens: providedTokens,
  onOpenLink,
}: WorkbenchConsoleOutputLineProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const tokens = useMemo(
    () => providedTokens ?? highlightWorkbenchConsoleOutput(text),
    [providedTokens, text]
  )

  return (
    <pre className={className} data-stream={stream}>
      {tokens.map((token, index): ReactNode => {
        if (token.kind === 'link') {
          const url = token.text
          return (
            <span key={`${index}-link`} className={styles.consoleLinkGroup}>
              <span
                role="link"
                tabIndex={0}
                className={styles.consoleLink}
                title={onOpenLink ? t('workbench.runOpenInternal') : t('workbench.runOpenExternal')}
                onClick={() => (onOpenLink ? onOpenLink(url) : openExternalUrl(url))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpenLink ? onOpenLink(url) : openExternalUrl(url)
                  }
                }}
              >
                {url}
              </span>
              <span
                role="button"
                tabIndex={0}
                className={styles.consoleLinkExternal}
                title={t('workbench.runOpenExternal')}
                aria-label={t('workbench.runOpenExternal')}
                onClick={() => openExternalUrl(url)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openExternalUrl(url)
                  }
                }}
              >
                <ArrowSquareOutIcon size={11} weight="bold" />
              </span>
            </span>
          )
        }

        const tokenClass = TOKEN_CLASS[token.kind]
        if (!tokenClass && !token.color) return token.text

        return (
          <span
            key={`${index}-${token.kind}`}
            className={tokenClass}
            style={token.color ? { color: token.color } : undefined}
          >
            {token.text}
          </span>
        )
      })}
    </pre>
  )
}
