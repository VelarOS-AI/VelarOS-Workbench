import { describe, expect, test } from 'bun:test'

import { displayPath, projectRelativePaths } from '../src/main/engines/WorkbenchEnginePermissions'

describe('engine permission paths', () => {
  test('a file whose name starts with two dots is still inside the project', () => {
    expect(displayPath('/work/app', '..env.local')).toBe('..env.local')
    expect(displayPath('/work/app', '/work/app/src/..cache/a.ts')).toBe('src/..cache/a.ts')
    expect(projectRelativePaths('/work/app', ['..env.local', 'src/a.ts'])).toEqual(['..env.local', 'src/a.ts'])
  })

  test('paths outside the project stay absolute or are dropped', () => {
    expect(displayPath('/work/app', '../other/b.ts')).toBe('/work/other/b.ts')
    expect(displayPath('/work/app', '/etc/hosts')).toBe('/etc/hosts')
    expect(projectRelativePaths('/work/app', ['../other/b.ts', '/etc/hosts', 'src/a.ts'])).toEqual(['src/a.ts'])
  })
})
