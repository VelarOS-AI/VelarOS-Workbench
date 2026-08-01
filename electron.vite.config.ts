import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

/**
 * VelarOS Workbench 单体仓库的 electron-vite 构建入口。
 *
 * 全部产品源码直接归根 src；跨仓 Platform 依赖仍经正式包入口解析，
 * 需要联调时先运行显式 `link:local`。
 */
const repoRoot = dirname(fileURLToPath(import.meta.url))

function source(...segments: string[]): string {
  return resolve(repoRoot, 'src', ...segments)
}

const mainAliases = [
  { find: /^@main\/(.+)$/, replacement: source('main', '$1') },
  { find: /^@shared\/(.+)$/, replacement: source('shared', '$1') },
]

const rendererAliases = [
  { find: /^@renderer\/(.+)$/, replacement: source('renderer/src', '$1') },
  { find: /^@shared\/(.+)$/, replacement: source('shared', '$1') },
]

export default defineConfig({
  main: {
    build: {
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
        },
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
    build: {
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
      rollupOptions: {
        input: source('renderer/index.html'),
      },
    },
    server: {
      fs: { allow: [repoRoot] },
    },
    css: {
      modules: {
        // Workbench 页样式按 surface 拆成多个 module.css 段（styles/workbenchPageStyles.ts），
        // 跨段选择器（主题块引用编辑器/文件树类）要求所有段产出同一类名——固定 local 名,
        // 不用默认哈希（哈希按文件隔离,会打断跨段级联）。
        generateScopedName: 'wb_[local]',
      },
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'],
      alias: rendererAliases,
    },
    plugins: [react()],
  },
})
