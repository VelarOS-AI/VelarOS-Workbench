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

test('code stays stable while optional analysis follows installed capabilities in an already-open project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-query-availability-'))
  const resource = new ChangingCodeGraphResource({ sharedResourcesRoot: root })
  const provider = new ProjectCapabilityProvider({ codeGraphResource: resource })
  try {
    const project = await provider.resolveProject(root)
    const tool = project.tools.find((candidate) => candidate.name === 'project:code')
    const analysis = project.tools.find((candidate) => candidate.name === 'project:code-analysis')
    assert(tool)
    assert(analysis)
    assert(tool.schema.safeParse({ action: 'symbols', query: 'example' }).success)
    assert(!tool.schema.safeParse({ action: 'build_index' }).success)
    assert(!tool.description.includes('build_index'))
    assert.equal(analysis.isAvailable?.({}), false)
    resource.available = true
    assert.equal(await provider.resolveProject(root), project)
    assert.equal(analysis.isAvailable?.({}), true)
    assert(analysis.schema.safeParse({ action: 'cycles' }).success)
    assert(analysis.schema.safeParse({ action: 'routing' }).success)
    assert(!analysis.schema.safeParse({ action: 'trace', from: { path: 'a.ts', symbol: 'a' }, to: { path: 'b.ts', symbol: 'b' } }).success)
    assert(!analysis.schema.safeParse({ action: 'deadcode' }).success)
    assert(!tool.schema.safeParse({ action: 'build_index' }).success)
    resource.available = false
    assert.equal(analysis.isAvailable?.({}), false)
  } finally {
    await provider.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
