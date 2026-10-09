// 用途：为 Windows 程序目录打包独立更新进程和文件归属清单。
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'

export default async function prepareWindowsUpdater(context) {
  if (context.electronPlatformName !== 'win32') return
  await build({
    entryPoints: [join(context.packager.projectDir, 'resources/updates/windows-update.cjs')],
    outfile: join(context.appOutDir, 'resources/windows-update.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
  })
  const manifestName = 'windows-update-manifest.json'
  const entries = [...new Set([...(await readdir(context.appOutDir)), manifestName])].sort()
  await writeFile(
    join(context.appOutDir, manifestName),
    JSON.stringify({
      schema: 1,
      appId: context.packager.appInfo.id,
      version: context.packager.appInfo.version,
      executable: `${context.packager.appInfo.productFilename}.exe`,
      entries,
    })
  )
}
