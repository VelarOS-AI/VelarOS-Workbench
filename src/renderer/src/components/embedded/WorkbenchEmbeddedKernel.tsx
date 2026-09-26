/**
 * 工作台中央装配件（左侧面板 + 编辑面），考古自 desktop 同名组件。
 *
 * 左侧面板：文件树、提交、Velar 结构、AI 改动（每一轮 AI 运行一棵改动文件树）。「AI 改动」的对比
 * 标签由页面组装进编辑区的独占标签组，这里只放左侧面板。结构（embeddedChrome 包装 / 类名 /
 * resize 把手）与原文逐字一致。
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
import { WorkbenchAiChangesPanel } from '../aiChanges/WorkbenchAiChangesPanel'
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
  /**
   * 文件面板宽度：px 数值，或一段 CSS 长度。独立工作台传外壳上的 `var(--workbench-file-pane-width)`，
   * 拖分隔条时外壳变量逐帧直写，这里不必每帧重渲染也能跟上。
   */
  filePanelWidth: number | string
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
      {leftMode === 'ai-changes' ? (
        <WorkbenchAiChangesPanel
          projectRoot={model.activeProject.rootPath}
          aiChanges={model.aiChanges}
        />
      ) : leftMode === 'changes' ? (
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
        gitStateRevision={editor.gitStateRevision}
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
            '--workbench-embedded-file-pane-width':
              typeof embeddedChrome.filePanelWidth === 'number'
                ? `${embeddedChrome.filePanelWidth}px`
                : embeddedChrome.filePanelWidth,
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
