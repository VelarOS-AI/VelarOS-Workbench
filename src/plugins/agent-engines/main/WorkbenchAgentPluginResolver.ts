import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveVelarOSSharedResourcesRoot } from '../../../main/resources/VelarOSSharedResourceStore'

import {
  type ClaudeAgentSdkModule,
  isClaudeAgentSdkModule,
} from './ClaudeAgentPluginContract'

export class WorkbenchAgentPluginResolver {
  public constructor(
    private readonly sharedResourcesRoot = resolveVelarOSSharedResourcesRoot()
  ) {}

  public isInstalled(id: 'claude-agent' | 'chatgpt'): boolean {
    return id === 'claude-agent'
      ? this.resolveClaudeSdkEntry() !== null
      : this.resolveChatGptExtensionRoot() !== null
  }

  public resolvePackageRoot(id: 'claude-agent' | 'chatgpt'): string {
    return join(this.sharedResourcesRoot, id)
  }

  public readVersion(id: 'claude-agent' | 'chatgpt'): string | null {
    const root = this.resolvePackageRoot(id)
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version?: unknown
      }
      return typeof manifest.version === 'string' && manifest.version.trim()
        ? manifest.version
        : null
    } catch {
      return null
    }
  }

  public async loadClaudeSdk(): Promise<ClaudeAgentSdkModule> {
    const entry = this.resolveClaudeSdkEntry()
    if (!entry) throw new Error('Claude Agent 插件尚未安装。')
    const sdk: unknown = await import(pathToFileURL(entry).href)
    if (!isClaudeAgentSdkModule(sdk)) {
      throw new Error('Claude Agent 插件接口不完整，请重新安装。')
    }
    return sdk
  }

  private resolveClaudeSdkEntry(): string | null {
    const root = this.resolvePackageRoot('claude-agent')
    const entry = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
    return existsSync(join(root, 'package.json')) && existsSync(entry) ? entry : null
  }

  private resolveChatGptExtensionRoot(): string | null {
    const root = this.resolvePackageRoot('chatgpt')
    const extension = join(root, 'extension')
    return existsSync(join(root, 'package.json'))
      && existsSync(join(extension, 'manifest.json'))
      ? extension
      : null
  }
}
