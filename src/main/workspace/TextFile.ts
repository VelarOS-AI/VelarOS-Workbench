/** 文本似然门（照搬 desktop `workspace/workbench/TextFile.ts`）：NUL 立拒 + 控制字节占比 <8%。 */
function isLikelyTextFile(buffer: Buffer): boolean {
  if (buffer.length === 0) return true

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  if (sample.includes(0)) return false

  let suspicious = 0
  for (const byte of sample) {
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13
    if (byte < 32 && !isAllowedControl) {
      suspicious += 1
    }
  }

  return suspicious / sample.length < 0.08
}

export { isLikelyTextFile, isLikelyTextFile as isLikelyWorkbenchTextFile }
