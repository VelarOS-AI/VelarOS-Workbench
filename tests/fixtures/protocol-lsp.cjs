// 协议边界用的假语言服务器：验证"服务端也会发请求"和大消息分块两条链路。
// mode='server-request'：initialize 期间主动发三条服务端请求（其中一条 id 与客户端的
// initialize 请求撞车），并把客户端的回复结果编码进 completion 的 label 里。
// mode='chunked'：把一条大响应拆成头部分段 + 64 KiB 的 body 分块发出。
let buffer = Buffer.alloc(0)
const mode = process.argv[2] ?? 'server-request'
const ChunkBytes = 64 * 1024
const LargeBodyChars = 512 * 1024

const observed = {
  registerCapability: 'none',
  unknownMethod: 'none',
  configuration: 'none',
  workspaceFolders: 'none',
}

function send(message) {
  const json = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
}

function sendChunked(message) {
  const json = JSON.stringify(message)
  const body = Buffer.from(json, 'utf8')
  // 故意把 \r\n\r\n 分隔符拆到两次写入里，逼客户端跨 chunk 找帧边界。
  process.stdout.write(`Content-Length: ${body.length}\r\n`)
  process.stdout.write('\r\n')
  for (let offset = 0; offset < body.length; offset += ChunkBytes)
    process.stdout.write(body.subarray(offset, Math.min(offset + ChunkBytes, body.length)))
}

function largeLabel() {
  // 混入多字节字符，确保客户端不是按 chunk 逐块解码 UTF-8。
  return '组件'.repeat(LargeBodyChars / 2)
}

function initializeResult(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      capabilities: {
        completionProvider: {},
        hoverProvider: true,
      },
      serverInfo: { name: 'Protocol Fixture Language Server', version: '1.0.0' },
    },
  }
}

function handleClientRequest(message) {
  switch (message.method) {
    case 'initialize':
      if (mode === 'server-request') {
        // 与客户端 initialize 请求同一个 id：按 id 分派的客户端会用它错误地 resolve 掉自己的 Promise。
        send({ jsonrpc: '2.0', id: message.id, method: 'client/registerCapability', params: { registrations: [] } })
        send({ jsonrpc: '2.0', id: 'unknown-1', method: 'custom/serverOnly', params: {} })
        send({
          jsonrpc: '2.0',
          id: 'config-1',
          method: 'workspace/configuration',
          params: { items: [{ section: 'python' }, { section: 'editor' }] },
        })
        send({ jsonrpc: '2.0', id: 'folders-1', method: 'workspace/workspaceFolders' })
      }
      send(initializeResult(message.id))
      break
    case 'textDocument/completion':
      if (mode === 'chunked') {
        sendChunked({ jsonrpc: '2.0', id: message.id, result: { items: [{ label: largeLabel(), kind: 14 }] } })
        break
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { items: [{ label: JSON.stringify(observed), kind: 14 }] },
      })
      break
    case 'shutdown':
      send({ jsonrpc: '2.0', id: message.id, result: null })
      break
    case 'exit':
      process.exit(0)
      break
    default:
      if (message.id !== undefined)
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } })
  }
}

function handleClientResponse(message) {
  const outcome = message.error ? `error:${message.error.code}` : JSON.stringify(message.result ?? null)
  switch (message.id) {
    case 'unknown-1':
      observed.unknownMethod = outcome
      break
    case 'config-1':
      observed.configuration = outcome
      break
    case 'folders-1':
      observed.workspaceFolders = outcome
      break
    default:
      // initialize 的 id 与我们的 registerCapability 请求相同，回到这里就是客户端确实回了信。
      observed.registerCapability = outcome
  }
}

function handle(message) {
  if (typeof message.method === 'string') {
    handleClientRequest(message)
    return
  }
  handleClientResponse(message)
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const boundary = buffer.indexOf('\r\n\r\n')
    if (boundary < 0) break
    const header = buffer.subarray(0, boundary).toString('ascii')
    const match = /Content-Length:\s*(\d+)/iu.exec(header)
    if (!match) process.exit(2)
    const size = Number(match[1])
    const end = boundary + 4 + size
    if (buffer.length < end) break
    const body = buffer.subarray(boundary + 4, end).toString('utf8')
    buffer = buffer.subarray(end)
    handle(JSON.parse(body))
  }
})
