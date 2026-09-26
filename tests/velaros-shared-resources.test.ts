import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { velarosSharedResources } from '@velaros-ai/core/platform/shared-resources'

describe('VelarOS shared resources', () => {
  test('the shared account lives in the organization data root rather than Workbench userData', () => {
    // 磁盘布局是产品家族之间的 ABI：账号会话与 Desktop 同一处，登录一次两边都认。
    expect(
      velarosSharedResources.accountRoot({
        platform: 'darwin',
        env: {},
        homeDirectory: '/Users/example',
      })
    ).toBe(join('/Users/example', 'Library', 'Application Support', 'VelarOS', 'shared', 'account', 'v1'))
  })

  test('the Workbench account store takes its default directory from the Core owner', () => {
    // 不再留一份本地投影：一处漂了账号就不再共享。
    const store = readFileSync('src/main/account/WorkbenchSharedAccountStore.ts', 'utf8')
    expect(store).toContain("import { velarosSharedResources } from '@velaros-ai/core/platform/shared-resources'")
    expect(store).toMatch(/options\.rootDir \?\? velarosSharedResources\.accountRoot\(\)/u)
  })
})
