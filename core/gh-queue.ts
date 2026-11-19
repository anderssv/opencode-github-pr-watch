/**
 * One queue for every GitHub call in the process: at most `limit` run at once, so starting or checking many watches
 * doesn't start a hundred `gh` processes together, and a watch being started (the user waits for it) goes ahead of
 * background checks.
 */
export type GhPriority = "first" | "background";

export class GhQueue {
  private running = 0;
  private readonly waiting: Record<GhPriority, (() => void)[]> = { first: [], background: [] };

  constructor(private readonly limit: number) {}

  async run<T>(priority: GhPriority, work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.waiting[priority].push(resolve));
    else this.running++;
    try {
      return await work();
    } finally {
      const next = this.waiting.first.shift() ?? this.waiting.background.shift();
      if (next) next();
      else this.running--;
    }
  }
}
