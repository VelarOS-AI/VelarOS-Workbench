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

  public isInstalled(id: 'claude-agent' | 'codex-agent'): boolean {
    return id === 'claude-agent'
      ? this.resolveClaudeSdkEntry() !== null && this.resolveClaudeCommand() !== null
      : this.resolveCodexSdkEntry() !== null && this.resolveCodexCommand() !== null
  }

  public resolvePackageRoot(id: 'claude-agent' | 'codex-agent'): string {
    return join(this.sharedResourcesRoot, id)
  }

  public readVersion(id: 'claude-agent' | 'codex-agent'): string | null {
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

  public resolveClaudeCommand(): string | null {
    const root = this.resolvePackageRoot('claude-agent')
    const entry = join(
      root,
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      `claude${process.platform === 'win32' ? '.exe' : ''}`
    )
    return existsSync(entry) ? entry : null
  }

  public resolveCodexCommand(): string | null {
    const triple = CodexTargetTriples[`${process.platform}-${process.arch}`]
    if (!triple) return null
    const root = this.resolvePackageRoot('codex-agent')
    const entry = join(
      root,
      'node_modules',
      '@openai',
      `codex-${process.platform}-${process.arch}`,
      'vendor',
      triple,
      'bin',
      `codex${process.platform === 'win32' ? '.exe' : ''}`
    )
    return existsSync(entry) ? entry : null
  }

  private resolveClaudeSdkEntry(): string | null {
    const root = this.resolvePackageRoot('claude-agent')
    const entry = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
    return existsSync(join(root, 'package.json')) && existsSync(entry) ? entry : null
  }

  private resolveCodexSdkEntry(): string | null {
    const root = this.resolvePackageRoot('codex-agent')
    const entry = join(root, 'node_modules', '@openai', 'codex-sdk', 'dist', 'index.js')
    return existsSync(join(root, 'package.json')) && existsSync(entry) ? entry : null
  }
}

const CodexTargetTriples: Readonly<Record<string, string>> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}
