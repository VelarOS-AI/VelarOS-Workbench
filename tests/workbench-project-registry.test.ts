import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { WorkbenchProjectRegistry } from '../src/main/projects/WorkbenchProjectRegistry'
import type { WorkbenchProject } from '../src/shared/projectHub'

test('concurrent windows preserve imported project identities and never replace the registry with an old snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-project-registry-'))
  const first: WorkbenchProject = {
    id: 'existing-first',
    name: 'First',
    rootPath: join(root, 'first'),
    createdAt: 1,
    lastOpenedAt: 2,
    pinned: true,
  }
  const second: WorkbenchProject = {
    ...first,
    id: 'existing-second',
    name: 'Second',
    rootPath: join(root, 'second'),
    pinned: false,
  }
  try {
    const registry = new WorkbenchProjectRegistry(root)
    const [one, two] = await Promise.all([
      registry.resolve(first.rootPath, [first, second]),
      registry.resolve(second.rootPath, [first]),
    ])
    assert.equal(one.id, first.id)
    assert.equal(one.pinned, true)
    assert.equal(two.id, second.id)
    const third = await registry.resolve(join(root, 'third'), [first])
    const reopened = new WorkbenchProjectRegistry(root)
    assert.equal((await reopened.resolve(second.rootPath, [])).id, second.id)
    assert.equal((await reopened.resolve(third.rootPath, [first])).id, third.id)
    const saved = JSON.parse(
      await readFile(join(root, 'storage', 'project-registry.json'), 'utf8')
    ) as { projects: WorkbenchProject[] }
    assert.deepEqual(
      saved.projects.map((project) => project.id).sort(),
      [first.id, second.id, third.id].sort()
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
