/**
 * Answers from GitHub kept for a while and shared by every watch in the process (it lives in the process state, so a
 * reload keeps it). A call already on its way is shared instead of sent again. Failures are not kept.
 */
export class CallCache {
  private readonly entries = new Map<string, { until: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = Date.now, private readonly maxEntries = 5_000) {}

  get size(): number {
    return this.entries.size;
  }

  async get<T>(key: string, ttlMs: number | ((value: T) => number), read: () => Promise<T>): Promise<T> {
    const kept = this.entries.get(key);
    if (kept && kept.until > this.now()) return kept.value as T;
    const going = this.inFlight.get(key);
    if (going) return going as Promise<T>;
    const call = read().then((value) => {
      const ttl = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
      if (ttl > 0) this.keep(key, { until: this.now() + ttl, value });
      return value;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  private keep(key: string, entry: { until: number; value: unknown }): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const now = this.now();
      for (const [k, e] of this.entries) if (e.until <= now) this.entries.delete(k);
      // Still full: the oldest kept go first (a Map keeps insertion order).
      for (const k of this.entries.keys()) {
        if (this.entries.size < this.maxEntries) break;
        this.entries.delete(k);
      }
    }
    this.entries.set(key, entry);
  }
}
