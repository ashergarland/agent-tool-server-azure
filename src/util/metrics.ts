export interface LatencySnapshot {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly latencies: Readonly<Record<string, LatencySnapshot>>;
  readonly gauges: Readonly<Record<string, number>>;
}

const MAX_SAMPLES = 512;

const labelKey = (name: string, labels: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(labels)
    .filter(([, value]) => value.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.length === 0
    ? name
    : `${name}{${entries.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
};

/**
 * Small in-process metrics registry.
 *
 * Deliberately cardinality-bounded: labels are supplied by the server, never by a caller, so a
 * hostile client cannot grow this map. It records only counts and latencies — never inputs,
 * outputs, template source or parameter values.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();

  public increment(name: string, labels: Readonly<Record<string, string>> = {}, by = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  public gauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.gauges.set(labelKey(name, labels), value);
  }

  public observe(
    name: string,
    durationMs: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    const key = labelKey(name, labels);
    const bucket = this.samples.get(key) ?? [];
    bucket.push(durationMs);
    if (bucket.length > MAX_SAMPLES) bucket.shift();
    this.samples.set(key, bucket);
  }

  /** Times a promise and records both its latency and its outcome. */
  public async time<T>(
    name: string,
    labels: Readonly<Record<string, string>>,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      this.observe(name, Date.now() - startedAt, { ...labels, outcome: 'success' });
      this.increment(`${name}_total`, { ...labels, outcome: 'success' });
      return result;
    } catch (error) {
      this.observe(name, Date.now() - startedAt, { ...labels, outcome: 'failure' });
      this.increment(`${name}_total`, { ...labels, outcome: 'failure' });
      throw error;
    }
  }

  public snapshot(): MetricsSnapshot {
    const latencies: Record<string, LatencySnapshot> = {};
    for (const [key, bucket] of this.samples) {
      const sorted = [...bucket].sort((a, b) => a - b);
      const at = (quantile: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
      latencies[key] = {
        count: sorted.length,
        totalMs: sorted.reduce((total, value) => total + value, 0),
        maxMs: sorted[sorted.length - 1] ?? 0,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
      };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      latencies,
    };
  }
}
