import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

/**
 * 独立 VelarOS Workbench 应用的 electron-vite 构建入口。
 *
 * 本仓 Workbench 包在开发时解析到源码；跨仓依赖始终经已发布包入口解析，
 * 避免独立应用偷偷依赖 sibling 仓目录。需要联调时先运行显式 `link:local`。
 */
const appDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(appDir, '../..')

function pkg(...segments: string[]): string {
  return resolve(repoRoot, 'packages', ...segments)
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // 语言服务 worker 是第二入口：tsserver 建图/诊断耗时数秒，必须离开主线程，
        // 主进程 client 以 `new Worker(resolve(__dirname, 'workbench-language-worker.js'))`
        // 拉起同目录产物。typescript / vscode-* 经 package.json dependencies 外置（运行时
        // 从根 node_modules 解析），不打进 bundle。
        input: {
          index: resolve(appDir, 'src/main/index.ts'),
          'workbench-language-worker': resolve(
            appDir,
            'src/main/workspace/language/LanguageServiceWorker.ts'
          ),
        },
      },
    },
    resolve: {
      // @velaros-ai/workbench 走本仓源码（避免命中 stale dist），与 renderer 同判；
      // @velaros-ai/core 仍经 node_modules dist 解析并打进 bundle（与 main 既有行为一致）。
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'],
      alias: [
        { find: /^@velaros-ai\/workbench$/, replacement: pkg('workbench/src/index.ts') },
        { find: /^@velaros-ai\/workbench\/(.+)$/, replacement: pkg('workbench/src/$1') },
      ],
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(appDir, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(appDir, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(appDir, 'src/renderer/index.html'),
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
      alias: [
        { find: /^@velaros-ai\/workbench$/, replacement: pkg('workbench/src/index.ts') },
        { find: /^@velaros-ai\/workbench\/(.+)$/, replacement: pkg('workbench/src/$1') },
      ],
    },
    plugins: [react()],
  },
})
