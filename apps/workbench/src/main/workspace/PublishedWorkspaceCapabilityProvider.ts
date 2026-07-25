import { isAbsolute, resolve } from 'node:path'

import {
  createVelarosWorkspaceBridge,
  type VelarosWorkspaceBridge,
} from '@velaros-ai/workspace'

import type {
  WorkbenchWorkspaceInvokeRequest,
  WorkbenchWorkspaceOperation,
} from '../../shared/workbenchWorkspace'

export interface WorkbenchWorkspaceCapabilityProvider {
  invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown>
  dispose(): Promise<void>
}

export interface PublishedWorkspaceCapabilityProviderOptions {
  createBridge?: (projectRoot: string) => Promise<VelarosWorkspaceBridge>
}

/**
 * Product-owned Workspace registry backed by the independently published
 * @velaros-ai/workspace module.
 *
 * Kernel does not own project paths. Workbench resolves its own project root,
 * caches one module bridge per root, then calls the package's schema-validated
 * tools. No Workspace implementation is copied into this repository.
 */
export class PublishedWorkspaceCapabilityProvider
implements WorkbenchWorkspaceCapabilityProvider {
  private readonly bridges = new Map<string, Promise<VelarosWorkspaceBridge>>()
  private readonly createBridge: (projectRoot: string) => Promise<VelarosWorkspaceBridge>

  public constructor(options: PublishedWorkspaceCapabilityProviderOptions = {}) {
    this.createBridge = options.createBridge ?? (async (projectRoot) =>
      createVelarosWorkspaceBridge({ root: projectRoot }))
  }

  public async invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown> {
    const root = normalizeProjectRoot(request.projectRoot)
    const bridge = await this.getBridge(root)
    const tool = bridge.tools.find((candidate) => candidate.name === request.operation)
    if (!tool) {
      throw new Error(`Workspace operation "${request.operation}" is unavailable.`)
    }
    return tool.execute(request.input)
  }

  public async dispose(): Promise<void> {
    const bridges = await Promise.allSettled(this.bridges.values())
    this.bridges.clear()
    await Promise.all(bridges.flatMap((bridge) =>
      bridge.status === 'fulfilled' && bridge.value.asModule().dispose
        ? [bridge.value.asModule().dispose!()]
        : []))
  }

  private getBridge(projectRoot: string): Promise<VelarosWorkspaceBridge> {
    const existing = this.bridges.get(projectRoot)
    if (existing) return existing

    const created = this.createBridge(projectRoot).catch((error) => {
      this.bridges.delete(projectRoot)
      throw error
    })
    this.bridges.set(projectRoot, created)
    return created
  }
}

function normalizeProjectRoot(projectRoot: string): string {
  const trimmed = projectRoot.trim()
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new Error('Workspace projectRoot must be an absolute path.')
  }
  return resolve(trimmed)
}

export const WorkbenchWorkspaceOperations = Object.freeze({
  status: 'ws_status',
  read: 'ws_read',
  stat: 'ws_file_stat',
  listFiles: 'ws_list_files',
  search: 'ws_search',
  symbols: 'ws_symbols',
  resolveTarget: 'ws_resolve_target',
  buildEvidence: 'ws_build_evidence',
  diff: 'ws_diff',
  prepareEdit: 'ws_prepare_edit',
  amendEdit: 'ws_amend_edit',
  commitEdit: 'ws_commit_edit',
  applyEdit: 'ws_apply_edit',
  validate: 'ws_validate',
  rollback: 'ws_rollback',
  runBatch: 'ws_run_batch',
} satisfies Readonly<Record<string, WorkbenchWorkspaceOperation>>)
