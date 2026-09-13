import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { WorkbenchCodeGraphResource } from '../src/main/resources/WorkbenchCodeGraphResource'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

// The resource changes while the project's cached tool collection remains mounted.
class ChangingCodeGraphResource extends WorkbenchCodeGraphResource {
  public available = false
  public override describe() {
    return { ...super.describe(), available: this.available }
  }
}

test('query schema follows installed capabilities in an already-open project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-query-availability-'))
  const resource = new ChangingCodeGraphResource({ sharedResourcesRoot: root })
  const provider = new ProjectCapabilityProvider({ codeGraphResource: resource })
  try {
    const project = await provider.resolveProject(root)
    const tool = project.tools.find((candidate) => candidate.name === 'project:query-code')
    assert(tool)
    assert(tool.schema.safeParse({ action: 'find_symbols', query: 'example' }).success)
    assert(!tool.schema.safeParse({ action: 'build_index' }).success)
    assert(!tool.description.includes('build_index'))
    resource.available = true
    assert.equal(await provider.resolveProject(root), project)
    assert(tool.schema.safeParse({ action: 'build_index' }).success)
    assert(!tool.schema.safeParse({ action: 'trace', fromSymbol: 'a', toSymbol: 'b' }).success)
    assert(!tool.schema.safeParse({ action: 'type_hierarchy', nodeId: 'a' }).success)
    assert(!tool.schema.safeParse({ action: 'find_dead_code' }).success)
    resource.available = false
    assert(!tool.schema.safeParse({ action: 'build_index' }).success)
  } finally {
    await provider.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
