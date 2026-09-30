/**
 * 独立 Workbench 应用 preload：把项目枢纽与项目文件系统 IPC 面桥接为
 * `window.velarosWorkbenchProjectHub` / `window.velarosWorkbenchFs`。
 *
 * 只做通道转发，不含业务逻辑；桥面形状的单一权威是 shared/projectHub.ts 的
 * `WorkbenchProjectHubBridge` 与 shared/workbenchFs.ts 的 `WorkbenchFsBridge` 契约。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent, webUtils } from 'electron'

import { type WorkbenchProjectHubBridge, WorkbenchProjectHubChannels } from '../shared/projectHub'
import { type WorkbenchAccountBridge, WorkbenchAccountChannels } from '../shared/workbenchAccount'
import { type WorkbenchBrowserBridge, WorkbenchBrowserChannels } from '../shared/workbenchBrowser'
import {
  type WorkbenchConversationBridge,
  WorkbenchConversationChannels,
} from '../shared/workbenchConversation'
import { type WorkbenchFsBridge, WorkbenchFsChannels } from '../shared/workbenchFs'
import { type WorkbenchGitBridge, WorkbenchGitChannels } from '../shared/workbenchGit'
import {
  type WorkbenchLanguageBridge,
  WorkbenchLanguageChannels,
} from '../shared/workbenchLanguage'
import { type WorkbenchMemoryBridge, WorkbenchMemoryChannels } from '../shared/workbenchMemory'
import { type WorkbenchModelBridge, WorkbenchModelChannels } from '../shared/workbenchModel'
import {
  type WorkbenchProductAnalyticsBridge,
  WorkbenchProductAnalyticsChannels,
} from '../shared/workbenchProductAnalytics'
import {
  type WorkbenchTerminalBridge,
  WorkbenchTerminalChannels,
} from '../shared/workbenchTerminal'
import { type WorkbenchUpdateBridge, WorkbenchUpdateChannels } from '../shared/workbenchUpdate'
import { type WorkbenchWatchBridge, WorkbenchWatchChannels } from '../shared/workbenchWatch'
import {
  type WorkbenchWindowCloseBridge,
  WorkbenchWindowCloseChannels,
} from '../shared/workbenchWindowClose'
import {
  type WorkbenchWindowStateBridge,
  WorkbenchWindowStateChannels,
} from '../shared/workbenchWindowState'
import {
  type WorkbenchWorkspaceBridge,
  WorkbenchWorkspaceChannels,
} from '../shared/workbenchWorkspace'

const projectHubBridge: WorkbenchProjectHubBridge = {
  getState: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.getState),
  openProjectDialog: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.openProjectDialog),
  openProjectPath: (path) => ipcRenderer.invoke(WorkbenchProjectHubChannels.openProjectPath, path),
  switchProjectDialog: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.switchProjectDialog),
  switchProjectPath: (path) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.switchProjectPath, path),
  openProjectDialogInNewWindow: () =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.openProjectDialogInNewWindow),
  openProjectPathInNewWindow: (path) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.openProjectPathInNewWindow, path),
  cloneProjectInNewWindow: (remoteUrl) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.cloneProjectInNewWindow, remoteUrl),
  validateProjectPath: (path) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.validateProjectPath, path),
  openDroppedPaths: (paths) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.openDroppedPaths, paths),
  acknowledgeFileOpen: (id) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.acknowledgeFileOpen, id),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openSystemPath: (path) => ipcRenderer.invoke(WorkbenchProjectHubChannels.openSystemPath, path),
  revealSystemPath: (path) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.revealSystemPath, path),
  pickNewProjectLocation: () =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.pickNewProjectLocation),
  createProject: (locationPath, name) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.createProject, locationPath, name),
  removeRecentProject: (path) =>
    ipcRenderer.invoke(WorkbenchProjectHubChannels.removeRecentProject, path),
  closeProject: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.closeProject),
  returnToEntry: () => ipcRenderer.invoke(WorkbenchProjectHubChannels.returnToEntry),
  onStateChanged: (listener) => subscribe(WorkbenchProjectHubChannels.stateChanged, listener),
  onMenuCommand: (listener) => subscribe(WorkbenchProjectHubChannels.menuCommand, listener),
  setLocale: (locale) => ipcRenderer.send(WorkbenchProjectHubChannels.setLocale, locale),
}

const accountBridge: WorkbenchAccountBridge = {
  getState: () => ipcRenderer.invoke(WorkbenchAccountChannels.getState),
  ensureSignedIn: () => ipcRenderer.invoke(WorkbenchAccountChannels.ensureSignedIn),
  signIn: () => ipcRenderer.invoke(WorkbenchAccountChannels.signIn),
  signOut: () => ipcRenderer.invoke(WorkbenchAccountChannels.signOut),
  onChanged: (listener) => subscribe(WorkbenchAccountChannels.changed, listener),
  getModelPricing: () => ipcRenderer.invoke(WorkbenchAccountChannels.getModelPricing),
}

const fsBridge: WorkbenchFsBridge = {
  listDirectory: (request) => ipcRenderer.invoke(WorkbenchFsChannels.listDirectory, request),
  readFile: (request) => ipcRenderer.invoke(WorkbenchFsChannels.readFile, request),
  readImageFile: (request) => ipcRenderer.invoke(WorkbenchFsChannels.readImageFile, request),
  findExistingFiles: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.findExistingFiles, request),
  saveFile: (request) => ipcRenderer.invoke(WorkbenchFsChannels.saveFile, request),
  // beforeunload 兜底：同步落盘，走 sendSync（main 侧 event.returnValue 信封）。
  saveFileSync: (request) => ipcRenderer.sendSync(WorkbenchFsChannels.saveFileSync, request),
  createEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.createEntry, request),
  renameEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.renameEntry, request),
  moveEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.moveEntry, request),
  copyEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.copyEntry, request),
  inspectDeleteEntry: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.inspectDeleteEntry, request),
  deleteEntry: (request) => ipcRenderer.invoke(WorkbenchFsChannels.deleteEntry, request),
  restoreDeletedEntry: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.restoreDeletedEntry, request),
  restoreMissingFile: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.restoreMissingFile, request),
  listLocalHistory: (request) => ipcRenderer.invoke(WorkbenchFsChannels.listLocalHistory, request),
  readLocalHistorySnapshot: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.readLocalHistorySnapshot, request),
  searchEntries: (request) => ipcRenderer.invoke(WorkbenchFsChannels.searchEntries, request),
  searchContent: (request) => ipcRenderer.invoke(WorkbenchFsChannels.searchContent, request),
  cancelSearchContent: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.cancelSearchContent, request),
  replaceContent: (request) => ipcRenderer.invoke(WorkbenchFsChannels.replaceContent, request),
  onSearchContentProgress: (listener) =>
    subscribe(WorkbenchFsChannels.searchContentProgress, listener),
  listProjectFiles: (request) =>
    ipcRenderer.invoke(WorkbenchFsChannels.listProjectFiles, request),
  runCommand: (request) => ipcRenderer.invoke(WorkbenchFsChannels.runCommand, request),
  onRunCommandOutput: (listener) => subscribe(WorkbenchFsChannels.runCommandOutput, listener),
}

const languageBridge: WorkbenchLanguageBridge = {
  getDefinition: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.definition, request),
  getCompletions: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.completions, request),
  resolveCompletion: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.completionResolve, request),
  getDiagnostics: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.diagnostics, request),
  getProjectDiagnostics: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.projectDiagnostics, request),
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
  getSemanticTokens: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.semanticTokens, request),
  getCodeActions: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.codeActions, request),
  requestExtension: (request) => ipcRenderer.invoke(WorkbenchLanguageChannels.extension, request),
  getInlineCompletion: (request) =>
    ipcRenderer.invoke(WorkbenchLanguageChannels.inlineCompletion, request),
}

const watchBridge: WorkbenchWatchBridge = {
  start: (request) => ipcRenderer.invoke(WorkbenchWatchChannels.start, request),
  stop: (request) => ipcRenderer.invoke(WorkbenchWatchChannels.stop, request),
  onChanged: (listener) => subscribe(WorkbenchWatchChannels.changed, listener),
  onStatus: (listener) => subscribe(WorkbenchWatchChannels.status, listener),
}

const terminalBridge: WorkbenchTerminalBridge = {
  startSession: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.start, request),
  writeInput: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.write, request),
  resizeSession: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.resize, request),
  stopSession: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.stop, request),
  readCwd: (request) => ipcRenderer.invoke(WorkbenchTerminalChannels.cwd, request),
  onOutput: (listener) => subscribe(WorkbenchTerminalChannels.output, listener),
  acknowledgeOutput: (request) => ipcRenderer.send(WorkbenchTerminalChannels.acknowledge, request),
}

const gitBridge: WorkbenchGitBridge = {
  getSummary: (request) => ipcRenderer.invoke(WorkbenchGitChannels.summary, request),
  getLineStats: (request) => ipcRenderer.invoke(WorkbenchGitChannels.lineStats, request),
  getDiff: (request) => ipcRenderer.invoke(WorkbenchGitChannels.diff, request),
  getFileAtCommit: (request) => ipcRenderer.invoke(WorkbenchGitChannels.fileAtCommit, request),
  getBlame: (request) => ipcRenderer.invoke(WorkbenchGitChannels.blame, request),
  getLog: (request) => ipcRenderer.invoke(WorkbenchGitChannels.log, request),
  generateCommitMessage: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.generateCommitMessage, request),
  commit: (request) => ipcRenderer.invoke(WorkbenchGitChannels.commit, request),
  performFileAction: (request) => ipcRenderer.invoke(WorkbenchGitChannels.fileAction, request),
  performHunkAction: (request) => ipcRenderer.invoke(WorkbenchGitChannels.hunkAction, request),
  initialize: (request) => ipcRenderer.invoke(WorkbenchGitChannels.initialize, request),
  switchBranch: (request) => ipcRenderer.invoke(WorkbenchGitChannels.switchBranch, request),
  createBranch: (request) => ipcRenderer.invoke(WorkbenchGitChannels.createBranch, request),
  performRemoteAction: (request) => ipcRenderer.invoke(WorkbenchGitChannels.remoteAction, request),
  cancelRemoteAction: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.cancelRemoteAction, request),
  captureChatCheckpoint: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.captureChatCheckpoint, request),
  deleteChatCheckpoints: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.deleteChatCheckpoints, request),
  captureChatRunChanges: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.captureChatRunChanges, request),
  readChatRunChanges: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.readChatRunChanges, request),
  deleteChatRunChanges: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.deleteChatRunChanges, request),
  readChatRunChangeBaseFile: (request) =>
    ipcRenderer.invoke(WorkbenchGitChannels.readChatRunChangeBaseFile, request),
}

const conversationBridge: WorkbenchConversationBridge = {
  send: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.send, request),
  cancel: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.cancel, request),
  guidance: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.guidance, request),
  input: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.input, request),
  answer: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.answer, request),
  getGoal: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.getGoal, request),
  updateGoal: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.updateGoal, request),
  deleteSession: (request) =>
    ipcRenderer.invoke(WorkbenchConversationChannels.deleteSession, request),
  backupHistory: (request) =>
    ipcRenderer.invoke(WorkbenchConversationChannels.backupHistory, request),
  engines: (request) => ipcRenderer.invoke(WorkbenchConversationChannels.engines, request),
  onEvent: (listener) => subscribe(WorkbenchConversationChannels.event, listener),
}

const browserBridge: WorkbenchBrowserBridge = {
  getState: (request) => ipcRenderer.invoke(WorkbenchBrowserChannels.getState, request),
  attachPage: (request) => ipcRenderer.invoke(WorkbenchBrowserChannels.attachPage, request),
  detachPage: (request) => ipcRenderer.invoke(WorkbenchBrowserChannels.detachPage, request),
  navigate: (request) => ipcRenderer.invoke(WorkbenchBrowserChannels.navigate, request),
  leaveSite: (request) => ipcRenderer.invoke(WorkbenchBrowserChannels.leaveSite, request),
  onChanged: (listener) => subscribe(WorkbenchBrowserChannels.changed, listener),
}

const memoryBridge: WorkbenchMemoryBridge = {
  listEntries: (request) => ipcRenderer.invoke(WorkbenchMemoryChannels.listEntries, request),
  removeEntry: (request) => ipcRenderer.invoke(WorkbenchMemoryChannels.removeEntry, request),
}

const modelBridge: WorkbenchModelBridge = {
  listProviderModels: (request) =>
    ipcRenderer.invoke(WorkbenchModelChannels.listProviderModels, request),
  listManagedProviders: () =>
    ipcRenderer.invoke(WorkbenchModelChannels.listManagedProviders),
  getApiKey: (request) => ipcRenderer.invoke(WorkbenchModelChannels.getApiKey, request),
  setApiKey: (request) => ipcRenderer.invoke(WorkbenchModelChannels.setApiKey, request),
}

const workspaceBridge: WorkbenchWorkspaceBridge = {
  invoke: (request) => ipcRenderer.invoke(WorkbenchWorkspaceChannels.invoke, request),
}

const updateBridge: WorkbenchUpdateBridge = {
  getState: () => ipcRenderer.invoke(WorkbenchUpdateChannels.getState),
  check: () => ipcRenderer.invoke(WorkbenchUpdateChannels.check),
  download: () => ipcRenderer.invoke(WorkbenchUpdateChannels.download),
  pause: () => ipcRenderer.invoke(WorkbenchUpdateChannels.pause),
  resume: () => ipcRenderer.invoke(WorkbenchUpdateChannels.resume),
  cancel: () => ipcRenderer.invoke(WorkbenchUpdateChannels.cancel),
  restart: () => ipcRenderer.invoke(WorkbenchUpdateChannels.restart),
  setAutomaticDownloads: (enabled) =>
    ipcRenderer.invoke(WorkbenchUpdateChannels.setAutomaticDownloads, enabled),
  setChannel: (channel) => ipcRenderer.invoke(WorkbenchUpdateChannels.setChannel, channel),
  onChanged: (listener) => subscribe(WorkbenchUpdateChannels.changed, listener),
}

const windowStateBridge: WorkbenchWindowStateBridge = {
  getState: () => ipcRenderer.invoke(WorkbenchWindowStateChannels.getState),
  onChanged: (listener) => subscribe(WorkbenchWindowStateChannels.changed, listener),
}

const windowCloseBridge: WorkbenchWindowCloseBridge = {
  setUnsavedChanges: (unsaved) =>
    ipcRenderer.send(WorkbenchWindowCloseChannels.setUnsavedChanges, unsaved),
  onCloseRequested: (listener) => subscribe(WorkbenchWindowCloseChannels.closeRequested, listener),
  resolveCloseRequest: (response) =>
    ipcRenderer.send(WorkbenchWindowCloseChannels.resolveCloseRequest, response),
}

const productAnalyticsBridge: WorkbenchProductAnalyticsBridge = {
  getState: () => ipcRenderer.invoke(WorkbenchProductAnalyticsChannels.getState),
  setEnabled: (enabled) =>
    ipcRenderer.invoke(WorkbenchProductAnalyticsChannels.setEnabled, enabled),
  resolveNotice: (decision) =>
    ipcRenderer.invoke(WorkbenchProductAnalyticsChannels.resolveNotice, decision),
  openDetails: () => ipcRenderer.invoke(WorkbenchProductAnalyticsChannels.openDetails),
  onChanged: (listener) => subscribe(WorkbenchProductAnalyticsChannels.changed, listener),
}

contextBridge.exposeInMainWorld('velarosWorkbenchProjectHub', projectHubBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchAccount', accountBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchFs', fsBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchLanguage', languageBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchTerminal', terminalBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchWatch', watchBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchGit', gitBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchConversation', conversationBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchMemory', memoryBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchBrowser', browserBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchModel', modelBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchWorkspace', workspaceBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchUpdate', updateBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchWindowState', windowStateBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchWindowClose', windowCloseBridge)
contextBridge.exposeInMainWorld('velarosWorkbenchProductAnalytics', productAnalyticsBridge)

function subscribe<TPayload>(channel: string, listener: (payload: TPayload) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: TPayload): void => {
    listener(payload)
  }

  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}
