import type { ComponentProps, MouseEvent, ReactElement } from 'react'
import {
  type Components,
  defaultRehypePlugins,
  type ExtraProps,
  Streamdown,
} from 'streamdown'

import {
  prepareStreamdownMarkdownText,
  STREAMDOWN_MARKDOWN_LINK_SAFETY,
  STREAMDOWN_MARKDOWN_PLUGINS,
} from '@velaros-ai/ui/conversation/markdown'

import { resolveWorkbenchMarkdownLink } from '../../models/editor/workbenchMarkdownPreview'
import styles from '../../styles/workbenchPageStyles'

import 'streamdown/styles.css'

interface WorkbenchMarkdownPreviewProps {
  path: string
  content: string
  onOpenProjectPath: (path: string) => void
}

type MarkdownAnchorProps = ComponentProps<'a'> & ExtraProps

// Workbench owns local-project and external navigation itself. Keep Streamdown's
// raw HTML parsing and sanitizer, but omit its chat-oriented relative-link
// hardener, which deliberately turns project-relative links into "[blocked]".
export const WORKBENCH_MARKDOWN_REHYPE_PLUGINS = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== 'harden')
  .map(([, plugin]) => plugin)

export function WorkbenchMarkdownPreview({
  path,
  content,
  onOpenProjectPath,
}: WorkbenchMarkdownPreviewProps): ReactElement {
  const markdown = prepareStreamdownMarkdownText(content)
  const components: Components = {
    a: ({ href = '', children, ...props }: MarkdownAnchorProps) => {
      const resolved = resolveWorkbenchMarkdownLink(path, href)
      const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
        if (resolved.kind === 'fragment') return
        event.preventDefault()
        if (resolved.kind === 'external') {
          window.open(resolved.url, '_blank', 'noopener,noreferrer')
        } else if (resolved.kind === 'project') {
          onOpenProjectPath(resolved.path)
        }
      }

      return (
        <a
          {...props}
          href={resolved.kind === 'blocked' ? undefined : href}
          rel={resolved.kind === 'external' ? 'noreferrer' : undefined}
          target={resolved.kind === 'external' ? '_blank' : undefined}
          onClick={handleClick}
        >
          {children}
        </a>
      )
    },
  }

  return (
    <div className={styles.markdownPreview} data-testid="workbench-markdown-preview">
      <Streamdown
        className={styles.markdownPreviewContent}
        mode="static"
        animated={false}
        controls={false}
        linkSafety={STREAMDOWN_MARKDOWN_LINK_SAFETY}
        plugins={STREAMDOWN_MARKDOWN_PLUGINS}
        rehypePlugins={WORKBENCH_MARKDOWN_REHYPE_PLUGINS}
        lineNumbers={false}
        skipHtml
        components={components}
      >
        {markdown}
      </Streamdown>
    </div>
  )
}
