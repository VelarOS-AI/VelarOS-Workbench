import assert from 'node:assert/strict'

import { projectTools } from '@velaros-ai/project/agent'

import { WorkbenchAgentControlTools } from '../../src/main/agent/WorkbenchAgentControlTools'

export interface CapturedWorkbenchRequest {
  prompt: Array<{ role: string; content: unknown }>
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
}

const executableTools = new Map([
  ...Object.values(projectTools),
  ...WorkbenchAgentControlTools,
].map((tool) => [tool.name, tool]))

/** Check instructions sent now; historical/user/tool evidence is not executable guidance. */
export function assertCurrentWorkbenchPrompt(request: CapturedWorkbenchRequest, readonly = false): void {
  const instructions = [
    ...request.prompt.filter((message) => message.role === 'system').map((message) => message.content),
    ...(request.tools ?? []).flatMap((tool) => [tool.description, JSON.stringify(tool.inputSchema)]),
  ].join('\n')
  for (const name of ['map', 'replace']) {
    if (!(request.tools ?? []).some((tool) => tool.name === `tooling__${name}` || tool.name === `tooling:${name}`))
      assert.doesNotMatch(instructions, new RegExp(`tooling(?::|__)${name}\\b`), `Instructions refer to unavailable tooling:${name}`)
  }
  assert.doesNotMatch(instructions, /project(?::|__)(?:write|rollback|query_code|query-code)\b/)
  assert.doesNotMatch(instructions, /\b(?:expectedMatches|selectionRef|baseRevision|occurrence|replace_text|replace_lines|insert_before|insert_after|append_text|prepend_text)\b/)
  assert.doesNotMatch(instructions, /^\s*\d+\|/m)
  assert.doesNotMatch(instructions, /(?:重新输入|重新生成|resend|regenerate).{0,12}(?:完整参数|完整正文|full (?:input|body))/i)

  for (const tool of request.tools ?? []) {
    const canonicalName = tool.name.replace('__', ':')
    const executable = executableTools.get(canonicalName)
    if (readonly) assert.notEqual(executable?.capabilities?.effectKind, 'write', `Readonly worker received ${canonicalName}`)
    if (!executable) continue
    for (const example of (tool.description ?? '').matchAll(/调用参数示例：(.+)。/gu)) {
      assert(executable.schema.safeParse(JSON.parse(example[1]!)).success, `${canonicalName} advertised an invalid example: ${example[1]}`)
    }
  }
}
