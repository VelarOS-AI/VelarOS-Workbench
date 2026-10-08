import { memo, type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretDownIcon,
  CaretRightIcon,
  FolderIcon,
  FolderOpenIcon,
  NotePencilIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import type { WorkbenchChatRunFileChange } from '@shared/workbenchGit'

import type { WorkbenchAiChangesState } from '../../hooks/useWorkbenchAiChanges'
import {
  buildWorkbenchAiChangeTree,
  type WorkbenchAiChangeRound,
  type WorkbenchAiChangeTreeNode,
} from '../../models/chat/workbenchAiChangeRounds'
import { useWorkbenchRunChangeRecord } from '../../runtime/workbenchRunChangeRecords'
import pageStyles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

import styles from '../../styles/WorkbenchAiChanges.module.css'

interface WorkbenchAiChangesPanelProps {
  projectRoot: string
  aiChanges: WorkbenchAiChangesState
}

const StatusLetters: Record<WorkbenchChatRunFileChange['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
}

function formatRoundTime(timestamp: number, locale: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/**
 * 左侧「AI 改动」面板：右侧当前会话里 AI 每一轮改了哪些文件，一轮一棵文件树（最近的在上）。还在跑的
 * 那一轮标着「进行中」，随写入实时刷新。点文件在编辑区打开这一轮这个文件的只读对比。只列 Agent 改过的
 * 文件（按每轮的改动归属）；这一轮里 AI 之外也改过的文件挂一个「含外部改动」标记。
 */
export function WorkbenchAiChangesPanel({
  projectRoot,
  aiChanges,
}: WorkbenchAiChangesPanelProps): ReactElement {
  const { t, locale } = useWorkbenchI18n()
  const { rounds, expandedRoundKeys, revealRequest, activeTab, markRoundsSeen } = aiChanges
  const roundElementsRef = useRef(new Map<string, HTMLDivElement>())
  const fileCount = useMemo(
    () => rounds.reduce((total, round) => total + round.fileCount, 0),
    [rounds]
  )

  // 面板开着就算看过了：左侧图标上的新改动提示随之熄灭。
  useEffect(() => {
    markRoundsSeen()
  }, [markRoundsSeen, rounds])

  useEffect(() => {
    if (!revealRequest) return
    roundElementsRef.current
      .get(revealRequest.roundKey)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [revealRequest])

  return (
    <section className={styles.panel} aria-label={t('workbench.aiChangesTitle')}>
      <header className={pageStyles.panelHeader}>
        <div className={styles.headerTitle}>
          <span className={pageStyles.panelTitle}>{t('workbench.aiChangesTitle')}</span>
          {rounds.length > 0 && (
            <span className={pageStyles.panelSubtitle}>
              {t('workbench.aiChangesSummary', { rounds: rounds.length, files: fileCount })}
            </span>
          )}
        </div>
      </header>
      <div className={styles.scroll}>
        {rounds.length === 0 ? (
          <div className={styles.empty}>
            <NotePencilIcon size={20} weight="duotone" />
            <p>{t('workbench.aiChangesEmpty')}</p>
          </div>
        ) : (
          rounds.map((round) => (
            <div
              key={round.key}
              ref={(element) => {
                if (element) roundElementsRef.current.set(round.key, element)
                else roundElementsRef.current.delete(round.key)
              }}
            >
              <WorkbenchAiChangeRoundItem
                projectRoot={projectRoot}
                round={round}
                expanded={expandedRoundKeys.has(round.key)}
                activePath={activeTab?.roundKey === round.key ? activeTab.path : null}
                timeLabel={formatRoundTime(round.capturedAt, locale)}
                onToggle={aiChanges.toggleRound}
                onOpenFile={aiChanges.openFile}
              />
            </div>
          ))
        )}
      </div>
    </section>
  )
}

interface WorkbenchAiChangeRoundItemProps {
  projectRoot: string
  round: WorkbenchAiChangeRound
  expanded: boolean
  activePath: string | null
  timeLabel: string
  onToggle: (roundKey: string) => void
  onOpenFile: WorkbenchAiChangesState['openFile']
}

const WorkbenchAiChangeRoundItem = memo(function WorkbenchAiChangeRoundItem({
  projectRoot,
  round,
  expanded,
  activePath,
  timeLabel,
  onToggle,
  onOpenFile,
}: WorkbenchAiChangeRoundItemProps): ReactElement {
  const { t } = useWorkbenchI18n()
  return (
    <div className={styles.round} data-expanded={expanded}>
      <button
        type="button"
        className={styles.roundHeader}
        aria-expanded={expanded}
        onClick={() => onToggle(round.key)}
      >
        {expanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        <span className={styles.roundLabel}>
          {t('workbench.aiChangesRunLabel', { number: round.runNumber })}
        </span>
        {round.live && <span className={styles.roundLive}>{t('workbench.aiChangesLive')}</span>}
        <span className={styles.roundTime}>{timeLabel}</span>
        <span className={styles.roundStats}>
          <span className={styles.additions}>+{round.additions}</span>
          <span className={styles.deletions}>-{round.deletions}</span>
        </span>
      </button>
      <div className={styles.roundPrompt} title={round.prompt}>
        {round.prompt || t('workbench.aiChangesNoPrompt')}
      </div>
      {expanded && (
        <WorkbenchAiChangeRoundFiles
          projectRoot={projectRoot}
          round={round}
          activePath={activePath}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  )
})

function WorkbenchAiChangeRoundFiles({
  projectRoot,
  round,
  activePath,
  onOpenFile,
}: {
  projectRoot: string
  round: WorkbenchAiChangeRound
  activePath: string | null
  onOpenFile: WorkbenchAiChangesState['openFile']
}): ReactElement {
  const { t } = useWorkbenchI18n()
  // 还在跑的一轮每采一次 capturedAt 就变：记录随之重读，展开着的文件树跟着刷新。
  const { record, loading, failed } = useWorkbenchRunChangeRecord(
    projectRoot,
    round.sessionId,
    round.error ? null : round.recordId,
    round.capturedAt
  )
  const tree = useMemo(() => (record ? buildWorkbenchAiChangeTree(record.changes) : []), [record])
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  if (round.error || failed)
    return <div className={styles.roundFeedback}>{t('workbench.aiChangesUnavailable')}</div>
  if (loading)
    return (
      <div className={styles.roundFeedback}>
        <SpinnerGapIcon size={12} className={styles.spin} />
        {t('workbench.aiChangesLoading')}
      </div>
    )

  const toggleDirectory = (key: string): void =>
    setCollapsedDirectories((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const renderNodes = (nodes: readonly WorkbenchAiChangeTreeNode[], depth: number): ReactElement[] =>
    nodes.map((node) => {
      const indent = { paddingInlineStart: `${10 + depth * 12}px` }
      if (node.kind === 'directory') {
        const collapsed = collapsedDirectories.has(node.key)
        return (
          <div key={node.key} role="group">
            <button
              type="button"
              className={styles.treeRow}
              style={indent}
              aria-expanded={!collapsed}
              title={node.path}
              onClick={() => toggleDirectory(node.key)}
            >
              {collapsed ? <CaretRightIcon size={10} /> : <CaretDownIcon size={10} />}
              {collapsed ? (
                <FolderIcon size={14} weight="duotone" className={styles.folderIcon} />
              ) : (
                <FolderOpenIcon size={14} weight="duotone" className={styles.folderIcon} />
              )}
              <span className={styles.treeName}>{node.name}</span>
            </button>
            {!collapsed && renderNodes(node.children, depth + 1)}
          </div>
        )
      }
      const { change } = node
      const mixed = change.attribution === 'mixed'
      return (
        <button
          key={node.key}
          type="button"
          className={styles.treeRow}
          style={indent}
          data-file="true"
          data-active={activePath === change.path}
          data-status={change.status}
          data-attribution={change.attribution}
          title={mixed ? `${change.path}\n${t('workbench.aiChangesMixedHint')}` : change.path}
          onClick={() => onOpenFile(round, change)}
        >
          <span className={styles.treeCaretSpacer} />
          <WorkbenchFileTypeIcon fileName={change.path} size={14} />
          <span className={styles.treeName}>{node.name}</span>
          {mixed && <span className={styles.statusChip}>{t('workbench.aiChangesMixedChip')}</span>}
          <span className={styles.treeStats}>
            {change.additions > 0 && <span className={styles.additions}>+{change.additions}</span>}
            {change.deletions > 0 && <span className={styles.deletions}>-{change.deletions}</span>}
          </span>
          <span className={styles.statusLetter}>{StatusLetters[change.status]}</span>
        </button>
      )
    })

  return (
    <div className={styles.tree} role="tree" aria-label={t('workbench.aiChangesRunLabel', { number: round.runNumber })}>
      {renderNodes(tree, 0)}
    </div>
  )
}
