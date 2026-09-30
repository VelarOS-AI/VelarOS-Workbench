import { EventEmitter } from 'node:events'

import { describe, expect, test } from 'bun:test'

import { setWorkbenchMainLocale } from '../src/main/i18n/workbenchMainLocale'
import {
  WorkbenchLanguageServiceWorkerClient,
  type WorkbenchLanguageServiceWorkerFactoryOptions,
  type WorkbenchLanguageServiceWorkerPort,
} from '../src/main/workspace/language/LanguageServiceWorkerClient'

/** 记下创建参数与收到的每条消息；请求一律立刻答复空结果。 */
class RecordingWorker implements WorkbenchLanguageServiceWorkerPort {
  private readonly events = new EventEmitter()
  public readonly messages: unknown[] = []

  public postMessage(message: unknown): void {
    this.messages.push(message)
    const id = (message as { id?: number; operation?: string }).id
    if ((message as { operation?: string }).operation)
      queueMicrotask(() => this.events.emit('message', { id, result: { items: [] } }))
  }

  public on(event: 'message' | 'error' | 'exit', listener: (...args: never[]) => void): this {
    this.events.on(event, listener)
    return this
  }

  public terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('the language worker follows the interface language', () => {
  test('a new worker starts in the current language and hears about later switches', async () => {
    setWorkbenchMainLocale('en-US')
    const created: WorkbenchLanguageServiceWorkerFactoryOptions[] = []
    const worker = new RecordingWorker()
    const client = new WorkbenchLanguageServiceWorkerClient((options) => {
      created.push(options)
      return worker
    })
    try {
      await client.getCompletions({
        projectRoot: '/project',
        path: 'src/index.ts',
        language: 'typescript',
        content: 'const value = 1\n',
        position: { line: 1, column: 7 },
      })
      expect(created.map((options) => options.locale)).toEqual(['en-US'])

      setWorkbenchMainLocale('zh-CN')
      expect(worker.messages).toContainEqual({ locale: 'zh-CN' })
    } finally {
      await client.dispose()
    }

    // 关掉以后不再转告。
    setWorkbenchMainLocale('en-US')
    expect(worker.messages.filter((message) => (message as { locale?: string }).locale)).toEqual([
      { locale: 'zh-CN' },
    ])
    setWorkbenchMainLocale('zh-CN')
  })
})
