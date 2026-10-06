/**
 * Latency histogram: 0.01 ms buckets below 1 ms (local services answer in microseconds), then 1 ms buckets up to
 * 60 s, plus an overflow bucket. Constant memory whatever the request count.
 */
const SUB_MS = 100; // buckets for 0.00–0.99 ms
const MAX_MS = 60_000;

const indexOf = (ms: number) =>
  ms < 1 ? Math.floor(ms * SUB_MS) : SUB_MS + Math.min(Math.round(ms), MAX_MS) - 1;
const valueOf = (i: number) => (i < SUB_MS ? i / SUB_MS : i - SUB_MS + 1);
const round2 = (n: number) => Math.round(n * 100) / 100;

export class LatencyHistogram {
  private readonly buckets = new Uint32Array(SUB_MS + MAX_MS);
  count = 0;
  private sum = 0;
  private minV = Infinity;
  private maxV = 0;

  add(ms: number): void {
    const v = Math.max(0, ms);
    this.buckets[indexOf(v)]!++;
    this.count++;
    this.sum += v;
    if (v < this.minV) this.minV = v;
    if (v > this.maxV) this.maxV = v;
  }

  get min(): number {
    return this.count ? round2(this.minV) : 0;
  }
  get max(): number {
    return round2(this.maxV);
  }
  get mean(): number {
    return this.count ? this.sum / this.count : 0;
  }

  /** Nearest-rank percentile (p in 0–100); 0 when empty. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      seen += this.buckets[i]!;
      if (seen >= rank) return valueOf(i);
    }
    return this.max;
  }
}
