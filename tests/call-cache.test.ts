import { describe, expect, test } from "bun:test";
import { CallCache } from "../core/call-cache";

describe("CallCache: GitHub answers kept across checks, reloads and watches", () => {
  test("within its time: asked once", async () => {
    let now = 0;
    const cache = new CallCache(() => now);
    let calls = 0;
    const read = () => cache.get("rules:o/r@main", 600_000, async () => ++calls);
    expect([await read(), await read()]).toEqual([1, 1]);
    now = 600_001;
    expect(await read()).toBe(2);
  });

  test("the same call already on its way is shared, not sent again", async () => {
    const cache = new CallCache(() => 0);
    let calls = 0;
    const slow = () => cache.get("runs:o/r@abc", 20_000, () => new Promise<number>((resolve) => setTimeout(() => resolve(++calls), 5)));
    expect(await Promise.all([slow(), slow(), slow()])).toEqual([1, 1, 1]);
  });

  test("a failure isn't kept", async () => {
    const cache = new CallCache(() => 0);
    await expect(cache.get("k", 60_000, async () => { throw new Error("404"); })).rejects.toThrow("404");
    expect(await cache.get("k", 60_000, async () => "ok")).toBe("ok");
  });

  test("the time can depend on the answer: a finished run's jobs are kept for good, a running one's briefly", async () => {
    let now = 0;
    const cache = new CallCache(() => now);
    const ttl = (jobs: string[]) => (jobs.includes("running") ? 20_000 : Infinity);
    let answer = ["running"];
    const jobs = () => cache.get("jobs:o/r:1", ttl, async () => answer);
    expect(await jobs()).toEqual(["running"]);
    answer = ["done"];
    now = 30_000;
    expect(await jobs()).toEqual(["done"]);
    answer = ["changed"];
    now = 10 * 86_400_000;
    expect(await jobs()).toEqual(["done"]);
  });

  test("old entries are dropped as new ones come, so it doesn't grow without end", async () => {
    let now = 0;
    const cache = new CallCache(() => now, 2);
    await cache.get("a", 1_000, async () => 1);
    await cache.get("b", Infinity, async () => 2);
    now = 5_000;
    await cache.get("c", 1_000, async () => 3);
    expect(cache.size).toBe(2);
  });
});
