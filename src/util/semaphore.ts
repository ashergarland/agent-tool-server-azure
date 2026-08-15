/** Counting semaphore. Bounds how much concurrent work a single process will attempt. */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  public constructor(private readonly permits: number) {
    if (permits < 1) throw new Error('Semaphore requires at least one permit');
    this.available = permits;
  }

  public get capacity(): number {
    return this.permits;
  }

  public get inUse(): number {
    return this.permits - this.available;
  }

  public get queued(): number {
    return this.waiters.length;
  }

  public async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}
