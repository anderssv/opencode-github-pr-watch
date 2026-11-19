import { describe, expect, test } from "bun:test";
import { budgetText, paceDelay, parseRateLimit } from "../core/budget";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const MIN = 60_000;

describe("paceDelay: background REST calls spread over what's left of the hour", () => {
  test("plenty left: no wait", () => {
    expect(paceDelay({ remaining: 3000, resetAt: NOW + 30 * MIN }, NOW, NOW - 10)).toBe(0);
  });

  test("little left: what's left (less a reserve for starts and the user's own gh) spread until the reset", () => {
    // 700 left, 200 kept back: 500 calls over 30 minutes is one every 3.6 s.
    expect(paceDelay({ remaining: 700, resetAt: NOW + 30 * MIN }, NOW, NOW)).toBe(3_600);
    expect(paceDelay({ remaining: 700, resetAt: NOW + 30 * MIN }, NOW, NOW - 1_000)).toBe(2_600);
  });

  test("at the reserve: wait for the reset", () => {
    expect(paceDelay({ remaining: 150, resetAt: NOW + 5 * MIN }, NOW, NOW)).toBe(5 * MIN);
  });

  test("not known yet, or past the reset: no wait", () => {
    expect(paceDelay(undefined, NOW, NOW)).toBe(0);
    expect(paceDelay({ remaining: 0, resetAt: NOW - 1 }, NOW, NOW)).toBe(0);
  });
});

describe("parseRateLimit and budgetText", () => {
  test("REST's budget from gh api rate_limit", () => {
    const json = JSON.stringify({ resources: { core: { limit: 5000, remaining: 812, reset: 1795081200 } } });
    expect(parseRateLimit(json)).toEqual({ remaining: 812, resetAt: 1795081200_000 });
  });

  test("said in the panel only while checks are slowed", () => {
    expect(budgetText({ remaining: 3000, resetAt: NOW + 30 * MIN }, NOW)).toBeUndefined();
    expect(budgetText({ remaining: 700, resetAt: NOW + 30 * MIN }, NOW)).toMatch(/^GitHub budget low \(700 calls left until \d\d:\d\d\); checks are slowed down$/);
  });
});
