let buffer = Buffer.alloc(0)
let initialized = false
const mode = process.argv[2]

function send(message) {
  const json = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      if (mode === 'oversized') {
        process.stdout.write(`Content-Length: ${16 * 1024 * 1024 + 1}\r\n\r\n`)
        break
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          capabilities: {
            completionProvider: {},
            definitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            renameProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            signatureHelpProvider: { triggerCharacters: ['(', ','] },
            documentFormattingProvider: true,
            inlayHintProvider: true,
            semanticTokensProvider: {
              legend: { tokenTypes: ['class', 'variable'], tokenModifiers: ['declaration'] },
              full: true,
            },
            codeActionProvider: { codeActionKinds: ['quickfix'] },
            experimental: { velar: { protocolVersion: 1 } },
          },
          serverInfo: { name: 'Fake Velar Language Server', version: '1.0.0' },
        },
      })
      break
    case 'initialized':
      initialized = true
      break
    case 'textDocument/didOpen':
    case 'textDocument/didChange': {
      const document = message.params.textDocument
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: document.uri,
          version: document.version,
          diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            severity: 1,
            code: 'VEL5001',
            source: 'fake-velar',
            message: initialized ? 'fake diagnostic' : 'not initialized',
          }],
        },
      })
      break
    }
    case 'textDocument/completion':
      if (mode === 'hang') break
      send({ jsonrpc: '2.0', id: message.id, result: { items: [{ label: 'component', kind: 14 }] } })
      break
    case 'textDocument/hover':
      send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: 'Velar hover' } } })
      break
    case 'textDocument/definition':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          uri: message.params.textDocument.uri,
          range: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } },
        },
      })
      break
    case 'textDocument/references':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [{
          uri: message.params.textDocument.uri,
          range: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } },
        }],
      })
      break
    case 'textDocument/documentHighlight':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [{
          range: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } },
          kind: 1,
        }],
      })
      break
    case 'textDocument/rename':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          changes: {
            [message.params.textDocument.uri]: [{
              range: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } },
              newText: message.params.newName,
            }],
          },
        },
      })
      break
    case 'textDocument/documentSymbol':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [{
          name: 'App',
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } },
        }],
      })
      break
    case 'textDocument/signatureHelp':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          activeSignature: 0,
          activeParameter: 0,
          signatures: [{ label: 'mount(node, target) -> none', parameters: [{ label: 'node' }, { label: 'target' }] }],
        },
      })
      break
    case 'textDocument/formatting':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [{
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          newText: 'component App:\n',
        }],
      })
      break
    case 'textDocument/inlayHint':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [{ position: { line: 0, character: 13 }, label: ': string', kind: 1, paddingRight: true }],
      })
      break
    case 'textDocument/semanticTokens/full':
      send({ jsonrpc: '2.0', id: message.id, result: { data: [0, 10, 3, 0, 1] } })
      break
    case 'textDocument/codeAction':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [{
          title: 'Apply fake quick fix',
          kind: 'quickfix',
          isPreferred: true,
          edit: {
            changes: {
              [message.params.textDocument.uri]: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                newText: 'let',
              }],
            },
          },
        }],
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
