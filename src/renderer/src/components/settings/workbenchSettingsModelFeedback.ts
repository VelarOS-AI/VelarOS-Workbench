/** Electron invoke wrappers are transport details, not useful settings feedback. */
export function cleanWorkbenchModelCatalogError(error: string): string {
  return error
    .replace(/^(?:Error:\s*)?Error invoking remote method ['"][^'"]+['"]:\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim()
}

export function getWorkbenchModelSignInReason(error: string): 'expired' | 'signed-out' | null {
  const message = cleanWorkbenchModelCatalogError(error)
  if (/登录(?:已)?失效|重新登录|session (?:has )?expired|sign in again/iu.test(message))
    return 'expired'
  if (/未登录|请先登录|not signed in|sign in to .+ first/iu.test(message)) return 'signed-out'
  return null
}
