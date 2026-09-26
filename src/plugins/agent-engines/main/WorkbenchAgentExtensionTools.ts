import { z } from 'zod'

import { ProjectCodeQuerySchema, ProjectToolNames } from '@velaros-ai/project'

import type { WorkbenchCodeGraphResource } from '../../../main/resources/WorkbenchCodeGraphResource'
import type { WorkbenchVelarLogicGraphService } from '../../../main/workspace/language/WorkbenchVelarLogicGraphService'

import type { ClaudeAgentSdkModule } from './ClaudeAgentPluginContract'

// Provider function names cannot all carry `:`, so the wire alias stays portable while the
// presented/tool-ledger identity is Platform's canonical `project:code`.
const ProjectCodeSearchToolName = 'project_code'
const LegacyProjectCodeSearchToolName = 'project_query_code'
const ProjectCodeToolIdentity = ProjectToolNames.code
const ProjectCodeSearchDescription =
  'Search the current project semantic graph. VelarScript projects use the compiler-owned live logic graph; other languages use the installed structural index.'

const ProjectCodeSearchShape = {
  query: z.string().min(1).describe('Symbol name or structural search query.'),
  kind: z.string().min(1).optional().describe('Optional symbol kind filter.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results.'),
}

/** Workbench 特有的只读扩展工具；两家引擎共享同一个执行器，不复制原生编辑/命令工具。 */
export class WorkbenchAgentExtensionTools {
  public constructor(
    private readonly codeGraph: WorkbenchCodeGraphResource,
    private readonly velarLogicGraph?: WorkbenchVelarLogicGraphService
  ) {}

  public codexSpecs(): ReadonlyArray<Record<string, unknown>> {
    return [{
      type: 'function',
      name: ProjectCodeSearchToolName,
      description: ProjectCodeSearchDescription,
      deferLoading: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1 },
          kind: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    }]
  }

  public claudeServer(
    projectRoot: string,
    sdk: ClaudeAgentSdkModule
  ): unknown {
    return sdk.createSdkMcpServer({
      name: 'velaros-workbench',
      version: '1.0.0',
      instructions: 'Read-only structural project tools contributed by VelarOS Workbench plugins.',
      tools: [sdk.tool(
        ProjectCodeSearchToolName,
        ProjectCodeSearchDescription,
        ProjectCodeSearchShape,
        async (input) => ({
          content: [{
            type: 'text',
            text: JSON.stringify(await this.execute(projectRoot, ProjectCodeSearchToolName, input)),
          }],
        }),
        { searchHint: 'project symbols code graph search', alwaysLoad: false }
      )],
    })
  }

  public async execute(
    projectRoot: string,
    toolName: string,
    value: unknown
  ): Promise<unknown> {
    if (toolName !== ProjectCodeSearchToolName && toolName !== LegacyProjectCodeSearchToolName) {
      throw new Error(`Unknown Workbench extension tool: ${toolName}`)
    }
    const input = z.object(ProjectCodeSearchShape).parse(value)
    const query = ProjectCodeQuerySchema.parse({
      action: 'search_symbols',
      query: input.query,
      kind: input.kind,
      limit: input.limit ?? 30,
    })
    if (query.action !== 'search_symbols') throw new Error('Unsupported project code query.')
    return this.velarLogicGraph?.isProject(projectRoot)
      ? this.velarLogicGraph.queryProjectCode(projectRoot, query)
      : this.codeGraph.queryProjectCode(projectRoot, query)
  }

  public isBundledReadOnlyTool(toolName: string): boolean {
    return [ProjectCodeSearchToolName, LegacyProjectCodeSearchToolName].some((name) =>
      toolName === name || toolName.endsWith(`__${name}`))
  }
}

export { ProjectCodeSearchToolName, ProjectCodeToolIdentity }
