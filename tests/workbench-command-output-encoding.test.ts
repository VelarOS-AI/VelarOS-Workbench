import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { CommandHelper } from '../src/main/workspace/CommandHelper'
import { CommandRunner } from '../src/main/workspace/CommandRunner'
import { PathResolver } from '../src/main/workspace/PathResolver'

test('Workbench preserves split UTF-8 in both returned output and streamed events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-output-'))
  try {
    const text = '中文🙂\\n\n'
    const script = `const bytes=Buffer.from(${JSON.stringify(text)});(async()=>{for(const byte of bytes){process.stdout.write(Buffer.from([byte]));process.stderr.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,10))}})()`
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const runner = new CommandRunner(new PathResolver(), new CommandHelper())
    const events = { stdout: '', stderr: '' }
    const result = await runner.runCommand(
      {
        projectRoot: root,
        command: `${quote(process.execPath)} -e ${quote(script)}`,
        timeoutMs: 5000,
      },
      (event) => {
        if (event.stream === 'stdout' || event.stream === 'stderr')
          events[event.stream] += event.chunk
      },
      undefined,
      true,
    )
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.stdout, text, JSON.stringify(result))
    assert.equal(result.stderr, text)
    assert.deepEqual(events, { stdout: text, stderr: text })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rolling output never starts inside a surrogate pair', () => {
  const helper = new CommandHelper()
  const buffer = helper.createOutputBuffer(3)
  helper.appendOutput(buffer, '中文🙂xy')
  assert.equal(buffer.text, 'xy')
  assert.equal(buffer.truncated, true)
  helper.appendOutput(buffer, '🙂')
  assert.equal(buffer.text, 'y🙂')
  assert.equal(Buffer.from(buffer.text).toString('utf8'), buffer.text)
})


test('failure diagnostics keep both streams, bounded without splitting Unicode', () => {
  const helper = new CommandHelper()
  assert.deepEqual(helper.summarizeFailureOutput('TS2322', ''), ['stdout:\nTS2322'])
  assert.deepEqual(helper.summarizeFailureOutput('', 'fatal'), ['stderr:\nfatal'])
  assert.deepEqual(helper.summarizeFailureOutput('error', 'banner'), ['stdout:\nerror', 'stderr:\nbanner'])
  assert.deepEqual(helper.summarizeFailureOutput('', ''), [])
  const issues = helper.summarizeFailureOutput(`${'🙂'.repeat(1000)  }x`, '中文'.repeat(1000))
  for (const issue of issues) {
    assert(issue.length <= 1000)
    assert.equal(Buffer.from(issue).toString('utf8'), issue)
  }
})
