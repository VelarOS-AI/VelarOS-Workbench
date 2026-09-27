import { FolderIcon, PlayCircleIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchContentSearchMatch } from '@renderer/models/files/workbenchContentSearchModel'
import { getWorkbenchFilePresentationVariant } from '@renderer/models/files/workbenchFilePresentation'
import { isWorkbenchTestFilePath } from '@renderer/models/files/workbenchTestFile'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import type { MouseEvent, ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import {
  type WorkbenchDirectoryEntry,
  type WorkbenchSearchEntriesResult,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchCodeSnippet } from '../editor/WorkbenchCodeSnippet'

import { WorkbenchFileTypeIcon } from './WorkbenchFileTypeIcon'

const cx = StyleUtils.bindCx(styles)

interface FileSearchResultsProps {
  activeSearchResultId: Nullable<string>
  contentSearchMatches: WorkbenchContentSearchMatch[]
  gitDecorations: WorkbenchGitDecorationMap
  isIndexingProject: boolean
  isSearchingEntries: boolean
  searchEntries: WorkbenchDirectoryEntry[]
  searchResult: Nullable<WorkbenchSearchEntriesResult>
  /** 当前的搜索词：代码片段里把它标出来。 */
  searchQuery: string
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
  searchQuery,
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
                      <span
                        className={styles.treeFileIcon}
                        data-kind={getWorkbenchFilePresentationVariant({ fileName: entry.name })}
                        data-test-file={isWorkbenchTestFilePath(entry.path) || undefined}
                      >
                        <WorkbenchFileTypeIcon fileName={entry.name} size={15} />
                        {isWorkbenchTestFilePath(entry.path) && (
                          <PlayCircleIcon
                            size={8}
                            weight="fill"
                            className={styles.treeTestFileBadge}
                            aria-hidden="true"
                          />
                        )}
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
                    <span
                      className={styles.treeFileIcon}
                      data-kind={getWorkbenchFilePresentationVariant({ fileName: match.fileName })}
                      data-test-file={isWorkbenchTestFilePath(match.path) || undefined}
                    >
                      <WorkbenchFileTypeIcon fileName={match.fileName} size={15} />
                      {isWorkbenchTestFilePath(match.path) && (
                        <PlayCircleIcon
                          size={8}
                          weight="fill"
                          className={styles.treeTestFileBadge}
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className={styles.searchResultCopy}>
                      <span className={styles.searchResultHeading}>
                        <Text truncate className={styles.searchResultName}>
                          {match.fileName}
                        </Text>
                        <Text truncate tone="caption" className={styles.searchResultPath}>
                          {match.path}:{match.line}
                        </Text>
                        {match.isOpen && (
                          <Text className={styles.searchContentBadge} tone="caption">
                            {t('workbench.quickOpenAlreadyOpen')}
                          </Text>
                        )}
                      </span>
                      <WorkbenchCodeSnippet
                        path={match.path}
                        text={match.excerpt}
                        query={searchQuery}
                        className={styles.searchContentExcerpt}
                      />
                    </span>
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
