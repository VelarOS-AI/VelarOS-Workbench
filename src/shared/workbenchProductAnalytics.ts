export const WorkbenchProductAnalyticsChannels = {
  getState: 'workbench:product-analytics:get-state',
  setEnabled: 'workbench:product-analytics:set-enabled',
  resolveNotice: 'workbench:product-analytics:resolve-notice',
  openDetails: 'workbench:product-analytics:open-details',
  changed: 'workbench:product-analytics:changed',
} as const

export interface WorkbenchProductAnalyticsState {
  readonly revision: number
  readonly enabled: boolean
  readonly noticeRequired: boolean
  readonly noticeResolved: boolean
  readonly consentDecision: 'unresolved' | 'allowed' | 'declined'
  readonly consentReceiptRecorded: boolean
}

export interface WorkbenchProductAnalyticsBridge {
  getState(): Promise<WorkbenchProductAnalyticsState>
  setEnabled(enabled: boolean): Promise<WorkbenchProductAnalyticsState>
  resolveNotice(decision: 'allowed' | 'declined'): Promise<WorkbenchProductAnalyticsState>
  openDetails(): Promise<void>
  onChanged(listener: (state: WorkbenchProductAnalyticsState) => void): () => void
}
