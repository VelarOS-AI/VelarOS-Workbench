import { createHash } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

import { isolateLinkedPackageWatcher, linkedPackageWatchIgnore } from './build-config/linkedPackageWatchPolicy'
import mainExternalEsmPlatformPackages from './scripts/release/mainExternalEsmPlatformPackages.json'

/**
 * VelarOS Workbench 单体仓库的 electron-vite 构建入口。
 *
 * 全部产品源码直接归根 src；跨仓 Platform 依赖只经 GitHub Packages 的正式包入口解析。
 */
const repoRoot = dirname(fileURLToPath(import.meta.url))
const linkedPackageIgnore = linkedPackageWatchIgnore(repoRoot)
const workbenchRendererRoot = resolve(repoRoot, 'src/renderer/src')
const sharedWorkbenchStyleRoot = resolve(workbenchRendererRoot, 'styles')
const standaloneWorkbenchChatStyle = resolve(
  workbenchRendererRoot,
  'host/standaloneWorkbenchChat.module.css'
)

function source(...segments: string[]): string {
  return resolve(repoRoot, 'src', ...segments)
}

function workbenchCssModuleName(name: string, filename: string): string {
  const normalizedFilename = resolve(filename.split('?')[0] ?? filename)
  if (
    normalizedFilename.startsWith(`${sharedWorkbenchStyleRoot}${sep}`)
    || normalizedFilename === standaloneWorkbenchChatStyle
  ) return `wb_${name}`

  // Workbench 的拆段样式有意共享 local class；npm UI 包必须按文件隔离，否则几十个
  // `.root` / `.icon` 会被压成同一条 `.wb_root` / `.wb_icon` 并污染整个 IDE。
  const fileHash = createHash('sha256')
    .update(normalizedFilename)
    .digest('hex')
    .slice(0, 8)
  return `velar_${fileHash}_${name}`
}

const mainAliases = [
  { find: /^@main\/(.+)$/, replacement: source('main', '$1') },
  { find: /^@shared\/(.+)$/, replacement: source('shared', '$1') },
]

const rendererAliases = [
  { find: /^@renderer\/(.+)$/, replacement: source('renderer/src', '$1') },
  { find: /^@shared\/(.+)$/, replacement: source('shared', '$1') },
]

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [isolateLinkedPackageWatcher(linkedPackageIgnore)],
    build: {
      outDir: resolve(repoRoot, 'build/electron/main'),
      externalizeDeps: false,
      // Main carries most Platform runtime code. Production minification keeps the
      // startup entry smaller while development builds retain readable output.
      minify: mode === 'production',
      rollupOptions: {
        // 语言服务 worker 是第二入口：tsserver 建图/诊断耗时数秒，必须离开主线程，
        // 主进程 client 以 `new Worker(resolve(__dirname, 'workbench-language-worker.js'))`
        // 拉起同目录产物。typescript / vscode-* 经 package.json dependencies 外置（运行时
        // 从根 node_modules 解析），不打进 bundle。
        input: {
          index: source('main/index.ts'),
          'workbench-language-worker': resolve(
            repoRoot,
            'src/main/workspace/language/LanguageServiceWorker.ts'
          ),
          // 内容搜索 worker：用户写的正则可能回溯很久，放在 worker 里跑，卡住就结束它，不卡主进程
          // （见 ContentSearchWorkerHost，同样按 `resolve(__dirname, 'workbench-search-worker.js')` 拉起）。
          'workbench-search-worker': resolve(repoRoot, 'src/main/workspace/ContentSearchWorker.ts'),
        },
        external: [
          'electron',
          // Platform 运行时（与 Desktop 一致）：脚本子进程入口、原生帮手与 ScriptAct 模板都按包内路径在运行时
          // 解析，打进 bundle 就找不到了；它们只发 ESM，由主进程的原生 ESM 在运行时从 node_modules 加载。
          // 同一份清单也是打包后 asar 依赖闭包检查的输入（scripts/release/externalEsmArchive.mjs）。
          ...mainExternalEsmPlatformPackages.map(
            (name) => new RegExp(`^${name.replaceAll('/', '\\/')}(?:\\/.+)?$`, 'u')
          ),
          // 伪终端是原生模块：留在 node_modules 里按平台加载，不进 bundle（见 WorkbenchPty.ts）。
          /^@lydell\/node-pty/u,
          'gpt-tokenizer',
          /^gpt-tokenizer\/.+/u,
          'typescript',
          'vscode-css-languageservice',
          'vscode-html-languageservice',
          'vscode-languageserver-textdocument',
          'vscode-markdown-languageservice',
          'vscode-uri',
        ],
      },
    },
    resolve: {
      // 主进程只能解析 main/shared，进程边界由别名集合显式收紧；
      // @velaros-ai/core 仍经 node_modules dist 解析并打进 bundle（与 main 既有行为一致）。
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'],
      alias: mainAliases,
    },
  },
  preload: {
    plugins: [isolateLinkedPackageWatcher(linkedPackageIgnore)],
    build: {
      outDir: resolve(repoRoot, 'build/electron/preload'),
      rollupOptions: {
        input: source('preload/index.ts'),
      },
    },
    resolve: {
      alias: [{ find: /^@shared\/(.+)$/, replacement: source('shared', '$1') }],
    },
  },
  renderer: {
    root: source('renderer'),
    build: {
      outDir: resolve(repoRoot, 'build/electron/renderer'),
      rollupOptions: {
        input: source('renderer/index.html'),
      },
    },
    server: {
      fs: { allow: [repoRoot] },
      watch: { ignored: [linkedPackageIgnore] },
    },
    css: {
      modules: {
        // Workbench 页样式按 surface 拆成多个 module.css 段（styles/workbenchPageStyles.ts），
        // 跨段选择器（主题块引用编辑器/文件树类）要求所有段产出同一类名——固定 local 名,
        // 不用默认哈希（哈希按文件隔离,会打断跨段级联）。该例外只属于 Workbench 自己；
        // 发布版 UI 包仍按文件哈希，避免第三方 CSS Module 的常见 local 名互相串样式。
        generateScopedName: workbenchCssModuleName,
      },
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'],
      alias: rendererAliases,
      // UI 包链接自本机的 VelarOS-UI 仓，它自己的 node_modules 里也有一份 React：必须复用宿主这一份，
      // 两个 React 实例会让 hooks 直接报错（Desktop 同样这样配）。图标库同理：UI 仓那份按整包打进来，
      // 复用宿主这一份才按用到的图标摇树（启动包差出约 400 KB）。
      dedupe: ['react', 'react-dom', '@phosphor-icons/react'],
    },
    plugins: [react(), tailwindcss()],
  },
}))
