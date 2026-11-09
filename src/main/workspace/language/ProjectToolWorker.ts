import { parentPort } from 'node:worker_threads'

import { AppError } from '@velaros-ai/velaros/core/error'

import { getWorkbenchJavaScriptLintDiagnostics } from './JavaScriptLinting'
import type { ProjectToolWorkerRequest, ProjectToolWorkerResponse } from './ProjectToolWorkerHost'
import { formatWorkbenchDocumentWithProjectPrettier } from './WorkbenchDocumentFormatter'

if (!parentPort) throw new AppError('INVARIANT', 'Project tool worker needs its main owner')
const port = parentPort
let previous = Promise.resolve()
port.on('message', (request: ProjectToolWorkerRequest) => {
  previous = previous.then(async () => {
    let response: ProjectToolWorkerResponse
    try {
      const result =
        request.operation === 'lint'
          ? await getWorkbenchJavaScriptLintDiagnostics(request.input)
          : await formatWorkbenchDocumentWithProjectPrettier(request.input)
      response = { id: request.id, result }
    } catch (error) {
      response = { id: request.id, error: AppError.from(error).toJSON() }
    }
    port.postMessage(response)
  })
  void previous.catch(() => port.close())
})
