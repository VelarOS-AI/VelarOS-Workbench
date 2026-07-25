#!/usr/bin/env node
// 用途：把非常用 CodeMirror 语法（Java/C++/Go/Rust）打成「可运行时下载」的自包含产物。
//
// 为什么：这些语法不随 App 内置发布，用户在 workbench 设置页按需下载。产物是跨平台的单个 ESM，
// 由渲染进程经 velaros-grammar:// 协议动态 import 加载（见 LanguageGrammarInstaller / workbenchCodeMirrorLanguage）。
//
// 关键机制：CodeMirror 靠 facet 对象身份识别，语法产物里的共享运行时（@codemirror/*、@lezer/{common,highlight,lr}）
// 必须复用 App 已加载的同一份实例。构建时把这些共享包的裸导入改写成从 globalThis.__VELAROS_CM__ 取值，
// 只内联各语言独有的 @lezer/<lang> 语法表。产物因此零裸导入、完全自包含，且共享符号仍指向 App 实例。
//
// 产物（与二进制插件产物同放 dist-plugins/，共用一个 artifact base；GitHub Release 资产名不能含 "/"，故扁平）：
//   dist-plugins/grammar-<id>-<version>.js + dist-plugins/grammars-manifest.json（version/sha256/size）。
//   - 生产：随 plugins:archive 一起上传 GitHub Releases（LanguageGrammarInstaller 的默认 artifact base）。
//   - 本地验证：VELAROS_PLUGIN_ARTIFACT_BASE=file:///…/dist-plugins 启动应用即可端到端走通。
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputRoot = join(repoRoot, 'dist-plugins')
const require = createRequire(join(repoRoot, 'package.json'))

/** 运行时由 App 提供的共享模块全局名。渲染进程需在加载任何语法前填充。 */
const RUNTIME_GLOBAL = '__VELAROS_CM__'

/** 共享运行时：内置语言已在用、必然已打包进 App，语法产物从全局取而非内联。 */
const SharedRuntimeModules = [
  '@codemirror/autocomplete',
  '@codemirror/language',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
]

/** 待打包语法：id → { 上游包, 工厂导出名 }。独有的 @lezer/<id> 会被内联进产物。 */
const Grammars = [
  { id: 'java', pkg: '@codemirror/lang-java', factory: 'java' },
  { id: 'cpp', pkg: '@codemirror/lang-cpp', factory: 'cpp' },
  { id: 'go', pkg: '@codemirror/lang-go', factory: 'go' },
  { id: 'rust', pkg: '@codemirror/lang-rust', factory: 'rust' },
]

/**
 * esbuild 插件：把共享运行时的裸导入解析成一个「从 globalThis 转发」的虚拟模块。
 * 按各共享包的真实命名导出逐个生成 `export const X = M.X`，保持具名 import 可用且指向 App 实例。
 */
function sharedRuntimePlugin() {
  return {
    name: 'velaros-shared-runtime',
    setup(pluginBuild) {
      const filter = new RegExp(
        `^(${SharedRuntimeModules.map((id) => id.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})$`
      )
      pluginBuild.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'velaros-shared' }))
      pluginBuild.onLoad({ filter: /.*/, namespace: 'velaros-shared' }, async (args) => {
        // 按 specifier 导入拿到干净的 ESM 具名导出（require.resolve 会命中 CJS interop 的 module.exports/default）。
        const namespace = await import(args.path)
        const names = Object.keys(namespace).filter(
          (name) => name !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
        )
        const accessor = `globalThis.${RUNTIME_GLOBAL}[${JSON.stringify(args.path)}]`
        const contents = [
          `const M = ${accessor};`,
          `if (!M) throw new Error(${JSON.stringify(`VelarOS grammar runtime missing: ${args.path}`)});`,
          ...names.map((name) => `export const ${name} = M[${JSON.stringify(name)}];`),
        ].join('\n')
        return { contents, loader: 'js' }
      })
    },
  }
}

/** 读取包版本：从 entry 路径向上找最近的 package.json（这些包 exports 未开放 ./package.json）。 */
async function readPackageVersion(pkg) {
  const entryDir = dirname(require.resolve(pkg))
  for (let current = entryDir; current !== dirname(current); current = dirname(current)) {
    const manifest = await readFile(join(current, 'package.json'), 'utf8').catch(() => null)
    if (manifest) {
      const parsed = JSON.parse(manifest)
      if (parsed.name === pkg) return parsed.version
    }
  }
  return '0.0.0'
}

async function bundleGrammar({ id, pkg, factory }) {
  const result = await build({
    stdin: {
      contents: `export { ${factory} as create } from ${JSON.stringify(pkg)}`,
      resolveDir: repoRoot,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    plugins: [sharedRuntimePlugin()],
  })

  const code = result.outputFiles[0].text
  const residual = [...code.matchAll(/from\s*["'](@[^"']+)["']/g)].map((match) => match[1])
  if (residual.length > 0) {
    throw new Error(`grammar ${id} still has bare imports: ${[...new Set(residual)].join(', ')}`)
  }

  const version = await readPackageVersion(pkg)
  const file = `grammar-${id}-${version}.js`
  await writeFile(join(outputRoot, file), code)

  const size = Buffer.byteLength(code)
  const sha256 = createHash('sha256').update(code).digest('hex')
  console.log(`packaged grammar ${id}@${version} (${(size / 1024).toFixed(1)} KB)`)
  return { id, version, file, sha256, size }
}

await mkdir(outputRoot, { recursive: true })
// 只清理自己的旧版本产物，别动同目录的二进制插件 tar.gz / manifest.json。
for (const entry of await readdir(outputRoot).catch(() => [])) {
  if (/^grammar-.*\.js$/.test(entry)) await rm(join(outputRoot, entry), { force: true })
}

const grammars = {}
for (const grammar of Grammars) {
  const artifact = await bundleGrammar(grammar)
  grammars[artifact.id] = {
    version: artifact.version,
    file: artifact.file,
    sha256: artifact.sha256,
    size: artifact.size,
  }
}

const manifestPath = join(outputRoot, 'grammars-manifest.json')
await writeFile(
  manifestPath,
  `${JSON.stringify({ runtimeGlobal: RUNTIME_GLOBAL, grammars, generatedAt: Date.now() }, null, 2)}\n`
)
console.log(`manifest written: ${manifestPath}`)
