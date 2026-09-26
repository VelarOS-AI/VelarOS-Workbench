import assert from 'node:assert/strict'

import { test } from 'bun:test'
import { z } from 'zod'

import { WorkbenchAgentExtensionTools } from '../src/plugins/agent-engines/main/WorkbenchAgentExtensionTools'

import { assertCurrentWorkbenchPrompt } from './helpers/workbenchPromptAudit'

test('external engines discover the same structural search scope and execute its advertised input', async () => {
  const queries: unknown[] = []
  const extension = new WorkbenchAgentExtensionTools({
    queryProjectCode: async (root: string, query: unknown) => {
      queries.push({ root, query })
      return { symbols: [{ name: 'parseInput' }] }
    },
  } as never)
  const codex = extension.codexSpecs()[0]!
  let registered: { name: string; description: string; shape: z.ZodRawShape; execute: (input: unknown) => Promise<unknown>; hints: { searchHint: string; alwaysLoad: boolean } } | undefined
  const server = extension.claudeServer('/tmp/fixture', {
    tool: (name: string, description: string, shape: z.ZodRawShape, execute: (input: unknown) => Promise<unknown>, hints: { searchHint: string; alwaysLoad: boolean }) => {
      registered = { name, description, shape, execute, hints }
      return registered
    },
    createSdkMcpServer: (input: unknown) => input,
  } as never) as { instructions: string }
  assert(registered)
  assert.equal(codex.name, registered.name)
  assert.equal(codex.description, registered.description)
  assert.equal(codex.deferLoading, true)
  assert.equal(registered.hints.alwaysLoad, false)
  assert.match(registered.hints.searchHint, /symbols/)
  assert.doesNotMatch(registered.hints.searchHint, /dependencies|edit|write/)
  const shape = z.strictObject(registered.shape)
  const schema = z.toJSONSchema(shape)
  assert.deepEqual(Object.keys((codex.inputSchema as any).properties), Object.keys(schema.properties!))
  assert.deepEqual((codex.inputSchema as any).required, schema.required)
  for (const name of Object.keys(schema.properties!)) {
    const { description: _description, ...constraints } = schema.properties![name] as Record<string, unknown>
    assert.deepEqual((codex.inputSchema as any).properties[name], constraints)
  }
  assertCurrentWorkbenchPrompt({
    prompt: [{ role: 'system', content: server.instructions }],
    tools: [{ name: registered.name, description: registered.description, inputSchema: codex.inputSchema }],
  })
  const input = { query: 'parseInput', kind: 'function', limit: 5 }
  assert(shape.safeParse(input).success)
  await extension.execute('/tmp/fixture', String(codex.name), input)
  await registered.execute(input)
  assert.deepEqual(queries, Array.from({ length: 2 }, () => ({ root: '/tmp/fixture', query: { action: 'search_symbols', query: 'parseInput', kind: 'function', limit: 5 } })))
})
