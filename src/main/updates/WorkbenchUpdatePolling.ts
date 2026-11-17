import { TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

const CheckIntervalMs = 15 * 60_000
const RetryIntervalMs = 60_000

/** Startup, periodic and wake-up checks share one task and a bounded retry cadence. */
export class WorkbenchUpdatePolling {
  #started = false
  #disposed = false
  #pending = false
  #lastAttempt = Number.NEGATIVE_INFINITY

  public constructor(
    private readonly check: () => Promise<void>,
    private readonly reportError: (error: unknown) => void,
    private readonly timers = new TimerScope({ name: 'WorkbenchUpdatePolling' }),
    private readonly now: () => number = Date.now
  ) {}

  public start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    this.wake()
  }

  public wake(): void {
    if (!this.#started || this.#disposed || this.#pending) return
    if (this.now() - this.#lastAttempt < RetryIntervalMs) return
    this.#pending = true
    this.#lastAttempt = this.now()
    this.timers.cancelAll()
    void this.check().then(
      () => this.#schedule(CheckIntervalMs),
      (error: unknown) => {
        this.reportError(error)
        this.#schedule(RetryIntervalMs)
      }
    )
  }

  #schedule(delay: number): void {
    this.#pending = false
    if (this.#disposed) return
    this.timers.after(delay, () => this.wake(), { unref: true })
  }

  public dispose(): void {
    this.#disposed = true
    this.timers.dispose()
  }
}
