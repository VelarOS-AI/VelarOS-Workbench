import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type NodeRuntimeEnvironment, nodeRuntimePackages } from '@velaros-ai/script'

import WorkbenchNodePackages from './workbenchNodePackages.json'

/** 标准 Node 二进制包由实际平台和架构确定。 */
function standardNodePackageName(): string {
  const platform = process.platform === 'win32' ? 'win' : process.platform
  return platform === 'darwin' && process.arch === 'arm64'
    ? 'node-bin-darwin-arm64'
    : `node-${platform}-${process.arch}`
}

/** 从随产品锁定的依赖解析真实 Node，发行版使用 ASAR 外的原生可执行文件。 */
export function resolveWorkbenchNodeExecutable(): string {
  const require = createRequire(import.meta.url)
  const name = standardNodePackageName()
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  return require
    .resolve(`${name}/bin/${executable}`)
    .replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1')
}

/** 只读取包身份与解析目录；模型按需查询原包文档，Node 在 import 时加载实现。 */
export function resolveWorkbenchNodeEnvironment(directory?: string): NodeRuntimeEnvironment {
  const require = createRequire(import.meta.url)
  const packages = [
    ...nodeRuntimePackages.defaults(directory),
    ...WorkbenchNodePackages.map((name) => {
      const paths = directory
        ? [join(directory, 'node_modules')]
        : (require.resolve.paths(name) ?? [])
      const modules = paths.find((path) => existsSync(join(path, name, 'package.json')))
      if (!modules) throw new AppError('UNAVAILABLE', `Workbench 代码执行环境缺少 ${name}`)
      const manifest: unknown = JSON.parse(
        readFileSync(join(modules, name, 'package.json'), 'utf8')
      )
      if (!isPlainObject(manifest) || manifest.name !== name || !isString(manifest.version))
        throw new AppError('UNAVAILABLE', `Workbench 代码工具包身份无效：${name}`)
      return { name, version: manifest.version, directory: dirname(modules) }
    }),
  ]
  return {
    id: createHash('sha256').update(JSON.stringify(packages)).digest('hex'),
    packages,
    skills: [],
  }
}
