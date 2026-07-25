import { FolderIcon } from '@phosphor-icons/react'
import type { MouseEvent, ReactElement } from 'react'

import {
  type WorkbenchDirectoryEntry,
  type WorkbenchSearchEntriesResult,
} from '@velaros-ai/core/types'
import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { useWorkbenchI18n } from '@velaros-ai/workbench/i18n'
import type { WorkbenchContentSearchMatch } from '@velaros-ai/workbench/models/files/workbenchContentSearchModel'
import type { WorkbenchGitDecorationMap } from '@velaros-ai/workbench/models/git/workbenchGitModel'

import styles from '../../styles/workbenchPageStyles'

const cx = StyleUtils.bindCx(styles)

interface FileSearchResultsProps {
  activeSearchResultId: Nullable<string>
  contentSearchMatches: WorkbenchContentSearchMatch[]
  gitDecorations: WorkbenchGitDecorationMap
  isIndexingProject: boolean
  isSearchingEntries: boolean
  searchEntries: WorkbenchDirectoryEntry[]
  searchResult: Nullable<WorkbenchSearchEntriesResult>
  selectedEntryPath: Nullable<string>
  onActivateSearchResult: (index: number) => void
  onContextMenuEntry: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
  onOpenContentSearchMatch: (match: WorkbenchContentSearchMatch) => void
  onOpenSearchEntry: (entry: WorkbenchDirectoryEntry) => void
}

export function FileSearchResults({
  activeSearchResultId,
  contentSearchMatches,
  gitDecorations,
  isIndexingProject,
  isSearchingEntries,
  searchEntries,
  searchResult,
  selectedEntryPath,
  onActivateSearchResult,
  onContextMenuEntry,
  onOpenContentSearchMatch,
  onOpenSearchEntry,
}: FileSearchResultsProps): ReactElement {
  const { t } = useWorkbenchI18n()

  return (
    <>
      {!!searchEntries.length && (
        <section className={styles.searchSection}>
          <Paragraph spacing="none" className={styles.searchSectionTitle}>
            {t('workbench.searchPathResults')}
            <Text>{searchEntries.length}</Text>
          </Paragraph>
          <ul className={styles.searchResultList}>
            {searchEntries.map((entry, index) => {
              const decoration = gitDecorations.get(entry.path)
              const resultId = `entry:${entry.path}`

              return (
                <li key={entry.path}>
                  <Button
                    variant="ghost"
                    size="block"
                    className={cx(
                      'searchResultRow',
                      activeSearchResultId === resultId && 'searchResultRowActive',
                      selectedEntryPath === entry.path && 'searchResultRowSelected'
                    )}
                    data-search-result-id={resultId}
                    data-git-tone={entry.type === 'file' ? decoration?.tone : undefined}
                    onClick={() => onOpenSearchEntry(entry)}
                    onMouseEnter={() => onActivateSearchResult(index)}
                    onContextMenu={(event) => onContextMenuEntry(entry, event)}
                  >
                    {entry.type === 'directory' ? (
                      <span className={styles.treeFolderIcon}>
                        <FolderIcon size={15} weight="duotone" />
                      </span>
                    ) : (
                      <span className={styles.treeFileIcon}>
                        <FileTypeIcon fileName={entry.name} size={15} />
                      </span>
                    )}
                    <span className={styles.searchResultCopy}>
                      <Text truncate className={styles.searchResultName}>
                        {entry.name}
                      </Text>
                      <Text truncate tone="caption" className={styles.searchResultPath}>
                        {entry.path}
                      </Text>
                    </span>
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {!!contentSearchMatches.length && (
        <section className={styles.searchSection}>
          <Paragraph spacing="none" className={styles.searchSectionTitle}>
            {t('workbench.searchContentResults')}
            <Text>{contentSearchMatches.length}</Text>
          </Paragraph>
          <ul className={styles.searchResultList}>
            {contentSearchMatches.map((match, index) => {
              const resultId = `content:${match.id}`

              return (
                <li key={match.id}>
                  <Button
                    variant="ghost"
                    size="block"
                    className={cx(
                      'searchResultRow',
                      activeSearchResultId === resultId && 'searchResultRowActive',
                      selectedEntryPath === match.path && 'searchResultRowSelected'
                    )}
                    data-search-result-id={resultId}
                    data-git-tone={gitDecorations.get(match.path)?.tone}
                    onClick={() => onOpenContentSearchMatch(match)}
                    onMouseEnter={() => onActivateSearchResult(searchEntries.length + index)}
                  >
                    <span className={styles.treeFileIcon}>
                      <FileTypeIcon fileName={match.fileName} size={15} />
                    </span>
                    <span className={styles.searchResultCopy}>
                      <Text truncate className={styles.searchResultName}>
                        {match.fileName}
                      </Text>
                      <Text truncate tone="caption" className={styles.searchResultPath}>
                        {match.path}:{match.line}
                      </Text>
                      <Text truncate className={styles.searchContentExcerpt}>
                        {match.excerpt}
                      </Text>
                    </span>
                    {match.isOpen && (
                      <Text className={styles.searchContentBadge} tone="caption">
                        {t('workbench.quickOpenAlreadyOpen')}
                      </Text>
                    )}
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {!searchEntries.length && !contentSearchMatches.length && (
        <Paragraph spacing="none" tone="secondary" className={styles.panelEmpty}>
          {isSearchingEntries ? t('workbench.searching') : t('workbench.noSearchResults')}
        </Paragraph>
      )}
      {isIndexingProject && (
        <Paragraph spacing="none" tone="muted" className={styles.panelHint}>
          {t('workbench.searchContentIndexing')}
        </Paragraph>
      )}
      {!!searchResult?.truncated && (
        <Paragraph spacing="none" tone="muted" className={styles.panelHint}>
          {t('workbench.searchTruncated')}
        </Paragraph>
      )}
    </>
  )
}
