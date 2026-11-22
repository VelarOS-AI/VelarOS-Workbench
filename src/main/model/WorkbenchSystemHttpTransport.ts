import { session } from 'electron'

import { AppError } from '@velaros-ai/velaros/core/error'

/** 让主进程 HTTP 请求走 Chromium 的系统代理，网络会话独立于页面。 */
export const fetchThroughWorkbenchSystemProxy: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new AppError('VALIDATION', 'Host requests require HTTP or HTTPS.')

  return session
    .fromPartition('velaros-workbench-host-http', { cache: false })
    .fetch(input instanceof URL ? url.href : input, { ...init, bypassCustomProtocolHandlers: true })
}
