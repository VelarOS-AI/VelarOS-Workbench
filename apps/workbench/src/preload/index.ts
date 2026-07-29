/**
 * 独立 Workbench 应用 preload：把项目枢纽与项目文件系统 IPC 面桥接为
 * `window.velarosWorkbenchProjectHub` / `window.velarosWorkbenchFs`。
 *
 * 只做通道转发，不含业务逻辑；桥面形状的单一权威是 shared/projectHub.ts 的
 * `WorkbenchProjectHubBridge` 与 shared/workbenchFs.ts 的 `WorkbenchFsBridge` 契约。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  type WorkbenchProjectHubBridge,
  WorkbenchProjectHubChannels,
} from '../shared/projectHub'
import {
  type WorkbenchAgentModsBridge,
  WorkbenchAgentModsChannels,
} from '../shared/workbenchAgentMods'
import { type WorkbenchFsBridge, WorkbenchFsChannels } from '../shared/workbenchFs'
import { type WorkbenchGitBridge, WorkbenchGitChannels } from '../shared/workbenchGit'
import { type WorkbenchKernelBridge, WorkbenchKernelChannels } from '../shared/workbenchKernel'
import {
  type WorkbenchLanguageBridge,
  WorkbenchLanguageChannels,
} from '../shared/workbenchLanguage'
import {
  type WorkbenchTerminalBridge,
  WorkbenchTerminalChannels,
} from '../shared/workbenchTerminal'
import { type WorkbenchWatchBridge, WorkbenchWatchChannels } from '../shared/workbenchWatch'
import {
  type WorkbenchWorkspaceBridge,
  WorkbenchWorkspaceChannels,
} from '../shared/workbenchWorkspace'

const projectHubBridge: WorkbenchProjectHubBridge = {
  getState: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.getState),
  openProjectDialog: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.openProjectDialog),
  openProjectPath: (path) => ipcRenderer.invoke(WorkbenchProjectHubChannels.openProjectPath, path),
  openSystemPath: (path) => ipcRenderer.invoke(WorkbenchProjectHubChannels.openSystemPath, path),
  pickNewProjectLocation: () =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.pickNewProjectLocation),
  createProject: (locationPath, name) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.createProject, locationPath, name),
  removeRecentProject: (path) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.removeRecentProject, path),
  closeProject: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.closeProject),
  onStateChanged: (listener) => subscribe(WorkbenchProjectHubChannels.stateChanged, listener),
  onMenuCommand: (listener) => subscribe(WorkbenchProjectHubChannels.menuCommand, listener),
}

const fsBridge: WorkbenchFsBridge = {
  listDirectory: (request) => ipcRenderer.invoke(WorkbenchFsChannels.listDirectory, request),
  readFile: (request) => ipcRenderer.invoke(WorkbenchFsChannels.readFile, request),
  saveFile: (request) => ipcRenderer.invoke(WorkbenchFsChannels.saveFile, request),
  // beforeunload 兜底：同步落盘，走 sendSync（main 侧 event.returnValue 信封）。
  saveFileSync: (request) => ipcRenderer.sendSync(WorkbenchFsChannels.saveFileSync, request),
  createEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.createEntry, request),
  renameEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.renameEntry, request),
  moveEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.moveEntry, request),
  deleteEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.deleteEntry, request),
  restoreDeletedEntry: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.restoreDeletedEntry, request),
  listLocalHistory: (request) => ipcRenderer.invoke(WorkbenchFsChannels.listLocalHistory, request),
  readLocalHistorySnapshot: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.readLocalHistorySnapshot, request),
  searchEntries: (request) => ipcRenderer.invoke(WorkbenchFsChannels.searchEntries, request),
  searchContent: (request) => ipcRenderer.invoke(WorkbenchFsChannels.searchContent, request),
  runCommand: (request) => ipcRenderer.invoke(WorkbenchFsChannels.runCommand, request),
  onRunCommandOutput: (listener) => subscribe(WorkbenchFsChannels.runCommandOutput, listener),
}

const languageBridge: WorkbenchLanguageBridge = {
  getDefinition: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.definition, request),
  getCompletions: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.completions, request),
  getDiagnostics: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.diagnostics, request),
  getRename: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.rename, request),
  getHover: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.hover, request),
  getReferences: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.references, request),
  getSignatureHelp: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.signatureHelp, request),
  getFormat: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.format, request),
  getDocumentSymbols: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.documentSymbols, request),
  getDocumentHighlights: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.documentHighlights, request),
  getInlayHints: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.inlayHints, request),
  listGrammars: () => ipcRenderer.invoke(WorkbenchLanguageChannels.listGrammars),
  installGrammar: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.installGrammar, request),
  onGrammarsChanged: (listener) =>
    subscribe(WorkbenchLanguageChannels.grammarsChanged, listener),
}

const watchBridge: WorkbenchWatchBridge = {
  start: (request) => ipcRenderer.invoke(WorkbenchWatchChannels.start, request),
  stop: (request) => ipcRenderer.invoke(WorkbenchWatchChannels.stop, request),
  onChanged: (listener) => subscribe(WorkbenchWatchChannels.changed, listener),
}

const terminalBridge: WorkbenchTerminalBridge = {
  startSession: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.start, request),
  writeInput: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.write, request),
  stopSession: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.stop, request),
  onOutput: (listener) => subscribe(WorkbenchTerminalChannels.output, listener),
}

const gitBridge: WorkbenchGitBridge = {
  getSummary: (request) => ipcRenderer.invoke(WorkbenchGitChannels.summary, request),
  getLineStats: (request) => ipcRenderer.invoke(WorkbenchGitChannels.lineStats, request),
  getDiff: (request) => ipcRenderer.invoke(WorkbenchGitChannels.diff, request),
  getFileAtCommit: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.fileAtCommit, request),
  getLog: (request) => ipcRenderer.invoke(WorkbenchGitChannels.log, request),
  generateCommitMessage: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.generateCommitMessage, request),
  commit: (request) => ipcRenderer.invoke(WorkbenchGitChannels.commit, request),
  performFileAction: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.fileAction, request),
  initialize: (request) => ipcRenderer.invoke(WorkbenchGitChannels.initialize, request),
  switchBranch: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.switchBranch, request),
  createBranch: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.createBranch, request),
  performRemoteAction: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.remoteAction, request),
}

const kernelBridge: WorkbenchKernelBridge = {
  getStatus: () => ipcRenderer.invoke(WorkbenchKernelChannels.getStatus),
  invoke: (request) => ipcRenderer.invoke(WorkbenchKernelChannels.invoke, request),
  onStatusChanged: (listener) =>
    subscribe(WorkbenchKernelChannels.statusChanged, listener),
  onAgentExecution: (listener) =>
    subscribe(WorkbenchKernelChannels.agentExecution, listener),
}

const workspaceBridge: WorkbenchWorkspaceBridge = {
  invoke: (request) => ipcRenderer.invoke(WorkbenchWorkspaceChannels.invoke, request),
}

const agentModsBridge: WorkbenchAgentModsBridge = {
  getOverview: () => ipcRenderer.invoke(WorkbenchAgentModsChannels.getOverview),
}

contextBridge.exposeInMainWorld('velarosWorkbenchProjectHub', projectHubBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchFs', fsBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchLanguage', languageBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchTerminal', terminalBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchWatch', watchBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchGit', gitBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchKernel', kernelBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchWorkspace', workspaceBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchAgentMods', agentModsBridge)

function subscribe<TPayload>(
  channel: string,
  listener: (payload: TPayload) => void
): () => void {
  const handler = (_event: IpcRendererEvent, payload: TPayload): void => {
    listener(payload)
  }

  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}
