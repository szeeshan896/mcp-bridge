/**
 * Caps how many delegations run at once. Each one is a full model doing real work, so an
 * unbounded number of them saturates the machine and spends the quota of whatever account
 * is behind them — and a caller that decides to ask five agents at once has no idea how
 * expensive that is.
 */
export class ConcurrencyLimit {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('maxConcurrent must be at least 1');
  }

  get queueDepth(): number {
    return this.waiting.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
