import { pathToFileURL } from 'node:url'

try {
  // 探针的顶层 await 和 finally 清理全部完成后，ConPTY 留下的原生句柄不再阻止退出。
  await import(pathToFileURL(process.argv[2]).href)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}

await new Promise((resolve) => process.stdout.write('', resolve))
await new Promise((resolve) => process.stderr.write('', resolve))
process.exit(process.exitCode ?? 0)
