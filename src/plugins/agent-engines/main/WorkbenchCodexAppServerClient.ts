import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import {
  getWorkbenchAgentEngineEnvironment,
  shouldDetachAgentEngineProcess,
  terminateAgentEngineProcessTree,
} from './WorkbenchAgentEngineProcess'

export type WorkbenchCodexRpcId = number | string

export interface WorkbenchCodexRpcEnvelope {
  id?: WorkbenchCodexRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: unknown): void
}

type EnvelopeListener = (envelope: WorkbenchCodexRpcEnvelope) => void

/** Codex app-server 的窄 JSONL 客户端；只拥有传输和请求相关性。 */
export class WorkbenchCodexAppServerClient {
  private readonly pending = new Map<WorkbenchCodexRpcId, PendingRequest>()
  private readonly listeners = new Set<EnvelopeListener>()
  private nextId = 1
  private stderrTail = ''
  private closed = false

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.receiveLine(line))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4_000)
    })
    child.once('error', (error) => this.failAll(error))
    child.once('close', (code) => {
      this.closed = true
      this.failAll(new Error(
        `Codex app-server 已退出（code=${String(code)}）。${this.stderrTail ? ` ${this.stderrTail}` : ''}`
      ))
    })
  }

  public static async create(): Promise<WorkbenchCodexAppServerClient> {
    const child = spawn('codex', ['app-server'], {
      detached: shouldDetachAgentEngineProcess(),
      env: await getWorkbenchAgentEngineEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new WorkbenchCodexAppServerClient(child)
    try {
      await client.request('initialize', {
        clientInfo: {
          name: 'velaros-workbench',
          title: 'VelarOS Workbench',
          version: '0.3.11',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      })
      client.notify('initialized')
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  public onEnvelope(listener: EnvelopeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server 已关闭。'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  public notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  public respond(id: WorkbenchCodexRpcId, result: unknown): void {
    this.write({ id, result })
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    terminateAgentEngineProcessTree(this.child.pid, 'SIGTERM')
    this.failAll(new Error('Codex app-server 已关闭。'))
  }

  private write(envelope: WorkbenchCodexRpcEnvelope): void {
    if (this.closed) throw new Error('Codex app-server 已关闭。')
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`)
  }

  private receiveLine(line: string): void {
    let envelope: WorkbenchCodexRpcEnvelope
    try {
      envelope = JSON.parse(line) as WorkbenchCodexRpcEnvelope
    } catch {
      return
    }
    if (envelope.id !== undefined && envelope.method === undefined) {
      const pending = this.pending.get(envelope.id)
      if (!pending) return
      this.pending.delete(envelope.id)
      if (envelope.error !== undefined) pending.reject(new Error(JSON.stringify(envelope.error)))
      else pending.resolve(envelope.result)
      return
    }
    for (const listener of this.listeners) listener(envelope)
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const listener of this.listeners) {
      listener({ method: 'transport/error', params: { error } })
    }
  }
}
