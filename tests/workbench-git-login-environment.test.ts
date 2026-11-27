import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench Git runs in the login-shell environment', () => {
  void test('the app hands one shared login-shell environment to every Git child process', () => {
    const entry = readSource('src/main/index.ts')
    const providers = readSource('src/main/WorkbenchMainCapabilityProviders.ts')
    const probe = readSource('src/main/workspace/git/gitProbe.ts')

    // 登录环境全应用只解析一次、用到才解析（不拖慢启动）：Git 借的是 Agent 命令、外部引擎同一个实例。
    assert.equal(entry.match(/createShellEnvironment\(/gu)?.length, 1)
    assert.match(
      entry,
      /createDefaultWorkbenchMainCapabilityProviders\([\s\S]*?\(\) => shellEnvironment\.getEnvironment\(\)\n\s*\)/u
    )
    assert.match(entry, /new WorkbenchShellHostRegistry\(shellEnvironment,/u)
    assert.match(providers, /new WorkbenchGitService\(\{ environment: loginEnvironment \}\)/u)
    // 探针给服务一份固定的环境，不看这台机器的 shell 配置和全局 git 配置。
    assert.match(probe, /new WorkbenchGitService\(\{ environment: [\s\S]*?ProbeGitEnvironment/u)
  })
})
