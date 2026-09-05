import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { ModelRequestClient } from '@velaros-ai/model'
import { createModelRuntimeComposition, type ModelRuntimeComposition } from '@velaros-ai/model/node'

import type { WorkbenchInlineCompletionResult } from '@shared/contracts'
import type { WorkbenchInlineCompletionBridgeRequest } from '@shared/workbenchLanguage'

const InlineCompletionMaxOutputTokens = 160
const InlineCompletionMaxChars = 480
const PrefixMaxChars = 4000
const SuffixMaxChars = 1200
const CursorMarker = '<|cursor|>'
const EmptyResult: WorkbenchInlineCompletionResult = { completion: '' }
type InlineCompletionModelRequestPort = Pick<ModelRequestClient, 'collectTextStream'>

/** Workbench 独立宿主的编辑器 Tab 补全生成器。 */
export class WorkbenchInlineCompletionGenerator {
  private readonly log = logRuntime.tag('WorkbenchInlineCompletionGenerator')

  public constructor(
    private readonly modelRequestService: InlineCompletionModelRequestPort = new ModelRequestClient(),
    private readonly modelComposition: ModelRuntimeComposition = createModelRuntimeComposition()
  ) {}

  public async generate(
    request: WorkbenchInlineCompletionBridgeRequest
  ): Promise<WorkbenchInlineCompletionResult> {
    if (!request.prefix.trim()) return EmptyResult

    try {
      const selection = {
        ...request.modelSelection,
        thinkingDepth: 'fast' as const,
      }
      const runtime = await this.modelComposition.agentModelRuntime.resolveRoleRuntime(selection, {
        providerRuntimeConfigs: [
          {
            provider: selection.provider,
            enabled: true,
            apiKey: selection.apiKey,
            baseURL: selection.baseURL,
            defaultModel: selection.model,
          },
        ],
        openRouter: { useFreeModelsForDebug: false },
      })
      const text = await this.modelRequestService.collectTextStream({
        endpoint: 'workbench.inline-completion',
        system: [
          'You are an inline code completion engine embedded in a code editor (like Cursor/Copilot).',
          'Continue the code exactly at the cursor marked by <|cursor|>.',
          'Output ONLY the raw text to insert at the cursor. No explanations, no comments about your answer, no markdown code fences.',
          'Do not repeat code that already appears before the cursor, and do not restate the code after the cursor.',
          'Prefer completing the current statement or block; keep indentation consistent with the surrounding code.',
          'If no meaningful completion is possible, return an empty string.',
        ].join('\n'),
        model: runtime.provider(runtime.model, runtime.modelRequestOptions),
        modelRequestOptions: runtime.modelRequestOptions,
        maxOutputTokens: InlineCompletionMaxOutputTokens,
        maxRetries: 0,
        messages: [{ role: 'user', content: this.buildPrompt(request) }],
        onError: () => undefined,
        stopWhen: (accumulated) => accumulated.length > InlineCompletionMaxChars,
      })

      return { completion: this.cleanCompletion(text) }
    } catch (error) {
      this.log.debug('inline completion generation failed; returning empty', {
        error: AppError.getMessage(error),
      })
      return EmptyResult
    }
  }

  private buildPrompt(request: WorkbenchInlineCompletionBridgeRequest): string {
    const prefix = request.prefix.slice(-PrefixMaxChars)
    const suffix = request.suffix.slice(0, SuffixMaxChars)
    const fileName = request.path?.split(/[\\/]/u).at(-1) ?? ''

    return [
      `Language: ${request.language || 'plaintext'}`,
      fileName ? `File: ${fileName}` : '',
      '',
      'Complete the code at the cursor marker. Return only the text to insert.',
      '',
      `${prefix}${CursorMarker}${suffix}`,
    ]
      .filter((line) => line !== '')
      .join('\n')
  }

  private cleanCompletion(rawText: string): string {
    let text = rawText.replace(CursorMarker, '')
    const fenceMatch = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/u)
    if (fenceMatch) text = fenceMatch[1] ?? ''
    text = text.replace(/\s+$/u, '')
    return text.trim() ? text : ''
  }
}
