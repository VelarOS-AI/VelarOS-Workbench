export interface WorkbenchMessageFingerprintInput {
  title: string
  description?: string
  tone?: string
}

const DEFAULT_DEDUPE_WINDOW_MS = 4000
const PRUNE_MIN_INTERVAL_MS = 30_000

export function makeWorkbenchMessageFingerprint(
  options: WorkbenchMessageFingerprintInput
): string {
  return JSON.stringify([options.tone ?? 'info', options.title, options.description ?? ''])
}

/**
 * Keeps repeated renderer failures from growing an unbounded toast stack.
 * The fingerprint also serves as Sonner's stable toast id, so a later repeat
 * updates the existing visible toast instead of inserting another card.
 */
export class WorkbenchMessageDedupe {
  private readonly recent = new Map<string, number>()
  private lastPruneAt = 0

  public constructor(private readonly windowMs = DEFAULT_DEDUPE_WINDOW_MS) {}

  public shouldSkip(options: WorkbenchMessageFingerprintInput, now = Date.now()): boolean {
    const fingerprint = makeWorkbenchMessageFingerprint(options)
    const lastShownAt = this.recent.get(fingerprint)
    if (lastShownAt !== undefined && now - lastShownAt < this.windowMs) return true

    this.recent.set(fingerprint, now)
    this.prune(now)
    return false
  }

  public clear(): void {
    this.recent.clear()
    this.lastPruneAt = 0
  }

  private prune(now: number): void {
    if (now - this.lastPruneAt < PRUNE_MIN_INTERVAL_MS && this.recent.size < 80) return

    this.lastPruneAt = now
    for (const [fingerprint, shownAt] of this.recent) {
      if (now - shownAt > this.windowMs) this.recent.delete(fingerprint)
    }
  }
}
