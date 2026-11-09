let buffer = Buffer.alloc(0)
let initialized = false
let initializeRootUri = null
let initializeWorkspaceFolders = []
const closedUris = []
const watchedUris = []
const documents = new Map()
let closedDocument = null
const mode = process.argv[2]

function send(message) {
  const json = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      initializeRootUri = message.params.rootUri
      initializeWorkspaceFolders = message.params.workspaceFolders ?? []
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
              legend: {
                tokenTypes: ['class', 'variable'],
                tokenModifiers: ['declaration', 'frameworkDefinition'],
              },
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
      documents.set(
        document.uri,
        {
          version: document.version,
          text: message.method === 'textDocument/didOpen'
            ? document.text
            : message.params.contentChanges[0].text,
        }
      )
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
      if (mode === 'documents' && closedDocument?.uri === document.uri) {
        // 同一 URI 再打开之后，旧缓冲的晚到诊断不能冒充新文档的诊断。
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri: document.uri,
            version: closedDocument.version,
            diagnostics: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              severity: 1,
              source: 'fake-velar',
              message: 'discarded diagnostic',
            }],
          },
        })
        closedDocument = null
      }
      break
    }
    case 'textDocument/didClose':
      closedUris.push(message.params.textDocument.uri)
      if (mode === 'documents' && !closedDocument) {
        closedDocument = {
          uri: message.params.textDocument.uri,
          ...documents.get(message.params.textDocument.uri),
        }
      }
      documents.delete(message.params.textDocument.uri)
      break
    case 'workspace/didChangeWatchedFiles':
      watchedUris.push(...message.params.changes.map((change) => change.uri))
      break
    case 'textDocument/completion':
      if (mode === 'hang') break
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          items: mode === 'many-completions'
            ? Array.from({ length: 600 }, (_, index) => ({
                label: `lookProperty${String(index).padStart(3, '0')}`,
                kind: 10,
              }))
            : [{
                label: 'component',
                kind: 14,
                ...(mode === 'runtime-root' || mode === 'documents'
                  ? {
                      detail: JSON.stringify({
                        cwd: process.cwd(),
                        rootUri: initializeRootUri,
                        workspaceFolders: initializeWorkspaceFolders,
                        pid: process.pid,
                        closedUris,
                        watchedUris,
                        documents: Object.fromEntries(
                          [...documents].map(([uri, document]) => [uri, document.text])
                        ),
                      }),
                    }
                  : {}),
              }],
        },
      })
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
      send({ jsonrpc: '2.0', id: message.id, result: { data: [0, 10, 3, 0, 3] } })
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
