// 用途：把 Windows ZIP 更新包的校验信息合入 electron-updater 元数据。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'

export async function finalizeWindowsUpdate(directory, zipName) {
  const zip = join(directory, zipName)
  const hash = createHash('sha512')
  for await (const bytes of createReadStream(zip)) hash.update(bytes)
  const sha512 = hash.digest('base64')
  const size = (await stat(zip)).size
  const metadataPath = join(directory, 'latest.yml')
  const metadata = yaml.load(await readFile(metadataPath, 'utf8'))
  metadata.files = [
    ...metadata.files.filter((file) => file.url !== zipName),
    { url: zipName, sha512, size },
  ]
  // 旧客户端仍可读取原有 EXE；新客户端明确选择 ZIP 更新包。
  await writeFile(metadataPath, yaml.dump(metadata, { lineWidth: -1 }))
  console.log(`Windows archive update ready: ${zipName}`)
}

const { version } = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
)
await finalizeWindowsUpdate(
  'artifacts/desktop',
  `VelarOS-Workbench-${version}-win-${process.arch}.zip`
)
