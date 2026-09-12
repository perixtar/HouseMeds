// Shared timeout + circuit-breaker wrapper for outbound adapter calls.

export class FreshPriceMonitorOpenError extends Error {
  constructor(label: string) {
    super(`Fresh price monitor open for "${label}" — too many recent failures`);
    this.name = 'FreshPriceMonitorOpenError';
  }
}

export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`"${label}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

interface FreshPriceMonitorOptions {
  /** Human-readable label used in errors and logs. */
  label: string;
  /** Abort the call if it hasn't resolved within this many ms. */
  timeoutMs: number;
  /** Consecutive failures before the monitor opens. */
  failureThreshold: number;
  /** How long the monitor stays open before allowing a trial call. */
  resetTimeoutMs: number;
}

type FreshPriceMonitorState = 'closed' | 'open' | 'half-open';

export class FreshPriceMonitor {
  private state: FreshPriceMonitorState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(private readonly options: FreshPriceMonitorOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.options.resetTimeoutMs) {
        throw new FreshPriceMonitorOpenError(this.options.label);
      }
      this.state = 'half-open';
    }

    try {
      const result = await this.withTimeout(fn());
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const { label, timeoutMs } = this.options;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new TimeoutError(label, timeoutMs)),
        timeoutMs,
      );
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}
