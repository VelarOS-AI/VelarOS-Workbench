/**
 * 工作台中央装配件（文件面 + 编辑面），考古自 desktop 同名组件的片2 裁形。
 *
 * 相对 desktop 原文裁掉的分支（复活批次见各注）：
 * - aiChanges 存档 diff 辅助选项卡 + 左面板（Phase 3 AI 面批）；
 * - webview 调试选项卡层 + Browser Mod 受控选项卡；
 * - 左面 'changes'（CommitPanel/会话变更，片4 git 面）与 'issues'（flagged tasks，Phase 3）。
 * 结构（embeddedChrome 包装 / 类名 / resize 把手）与原文逐字一致，方便后续批次 diff 回填。
 */
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { GlobeSimpleIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchDensity } from '@renderer/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchLogicGraphSidebar } from '../codeGraph/WorkbenchLogicGraphSidebar'
import {
  EditorPanel,
  type WorkbenchEditorPanelAuxiliaryTab,
} from '../editor/EditorPanel'
import { WorkbenchWebviewDebugPanel } from '../editor/WorkbenchWebviewDebugPanel'
import { FilePanel } from '../files/FilePanel'
import { WorkbenchCommitPanel } from '../git/WorkbenchCommitPanel'

import type {
  WorkbenchEmbeddedKernelLeftMode,
  WorkbenchEmbeddedKernelModel,
} from './workbenchEmbeddedKernelModel'

interface WorkbenchEmbeddedKernelProps {
  model: WorkbenchEmbeddedKernelModel
  leftMode: WorkbenchEmbeddedKernelLeftMode
  embeddedChrome?: WorkbenchEmbeddedKernelChrome
}

interface WorkbenchEmbeddedKernelChrome {
  density: WorkbenchDensity
  filePanelWidth: number
  isFilePanelOpen: boolean
  isFilePanelInline: boolean
  /** 编辑器字号等仅作用于代码面的偏好，显式穿过嵌套 shell，避免默认值覆盖。 */
  editorStyle?: CSSProperties
  onFilePanelResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function WorkbenchEmbeddedKernel({
  embeddedChrome,
  model,
  leftMode,
}: WorkbenchEmbeddedKernelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const { files, editor } = model
  const { debug } = editor
  const debugAuxiliaryTabs: WorkbenchEditorPanelAuxiliaryTab[] = [
    ...debug.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      label: tab.title,
      icon: <GlobeSimpleIcon size={13} />,
      active: debug.activeTabId === tab.id,
      kind: 'webview-debug',
      content: null,
      onSelect: () => debug.onSelect(tab.id),
      onClose: () => debug.onClose(tab.id),
    })),
    ...(debug.agentBrowser?.visible
      ? [{
          id: debug.agentBrowser.id,
          title: debug.agentBrowser.title,
          label: debug.agentBrowser.title,
          icon: <GlobeSimpleIcon size={13} />,
          active: debug.agentBrowser.active,
          kind: 'agent-browser',
          content: null,
          onSelect: debug.agentBrowser.onSelect,
          onClose: debug.agentBrowser.onClose,
        }]
      : []),
  ]
  const hasDebugTabsLayer = debug.tabs.length > 0 || !!debug.agentBrowser
  const debugTabsLayer = hasDebugTabsLayer ? (
    <div className={styles.webviewDebugLayer}>
      {debug.tabs.map((tab) => (
        <div
          key={tab.id}
          className={styles.webviewDebugLayerItem}
          data-active={debug.activeTabId === tab.id}
        >
          <WorkbenchWebviewDebugPanel
            url={tab.url}
            onNavigate={(url, title) => debug.onNavigate(tab.id, url, title)}
          />
        </div>
      ))}
      {!!debug.agentBrowser && (
        <div
          className={styles.webviewDebugLayerItem}
          data-active={debug.agentBrowser.visible && debug.agentBrowser.active}
        >
          {debug.agentBrowser.surface.render({
            onElementPicked: debug.agentBrowser.onPicked,
            onRequestClose: debug.agentBrowser.onClose,
          })}
        </div>
      )}
    </div>
  ) : null
  const editorDiff = {
    ...editor.diff,
    auxiliaryTabs: [...(editor.diff.auxiliaryTabs ?? []), ...debugAuxiliaryTabs],
    debugTabsLayer,
  }
  const leftPanel = (
    <div className={styles.leftToolContent}>
      {leftMode === 'changes' ? (
        <WorkbenchCommitPanel
          git={model.changes.git}
          onOpenDiff={model.changes.onOpenDiff}
          onOpenFile={model.changes.onOpenFile}
        />
      ) : leftMode === 'velar-structure' && model.velarStructure ? (
        <WorkbenchLogicGraphSidebar {...model.velarStructure} />
      ) : (
        <FilePanel
          tree={files.tree}
          search={files.search}
          handlers={files.handlers}
        />
      )}
    </div>
  )
  const editorPanel = (
    <section className={styles.ideMainPane} data-tour-id="workbench-editor">
      <EditorPanel
        chrome={editor.chrome}
        showTopBar={editor.showTopBar}
        workbenchTheme={editor.workbenchTheme}
        workbenchProject={editor.workbenchProject}
        workbenchEditor={editor.workbenchEditor}
        gitDecorations={editor.gitDecorations}
        selectedFileDiagnostics={editor.selectedFileDiagnostics}
        isSelectedFileDiagnosticsPending={editor.isSelectedFileDiagnosticsPending}
        tabs={editor.tabs}
        diff={editorDiff}
        workspace={editor.workspace}
      />
    </section>
  )

  if (embeddedChrome)
    return (
      <div
        className={`${styles.workbenchShell} ${styles.embeddedKernelRoot}`}
        data-tour-id="workbench-overview"
        data-file-panel-open={embeddedChrome.isFilePanelOpen}
        data-file-panel-inline={embeddedChrome.isFilePanelInline}
        data-workbench-theme={editor.workbenchTheme}
        data-workbench-density={embeddedChrome.density}
        style={
          {
            ...embeddedChrome.editorStyle,
            '--workbench-embedded-file-pane-width': `${embeddedChrome.filePanelWidth}px`,
          } as CSSProperties
        }
      >
        <aside className={styles.embeddedFilePane} data-tour-id="workbench-file-tree">
          {leftPanel}
        </aside>
        {embeddedChrome.isFilePanelOpen && (
          <div
            className={styles.embeddedFileResizeHandle}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.resizeFilePane')}
            onPointerDown={embeddedChrome.onFilePanelResizePointerDown}
          />
        )}
        {editorPanel}
      </div>
    )

  return (
    <>
      {leftPanel}
      {editorPanel}
    </>
  )
}
