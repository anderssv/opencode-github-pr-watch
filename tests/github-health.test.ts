import { describe, expect, test } from "bun:test";
import { classifyGhError, healthAfter, pausedText, type GithubHealth } from "../core/github-health";

const NOW = Date.parse("2026-11-18T12:00:00Z");

describe("classifyGhError: what kind of failure stops every call, not just one", () => {
  test("rate limits", () => {
    expect(classifyGhError("gh: API rate limit exceeded for user ID 1. (HTTP 403)")).toBe("rate-limit");
    expect(classifyGhError("gh: You have exceeded a secondary rate limit (HTTP 403)")).toBe("rate-limit");
    expect(classifyGhError("HTTP 429: Too Many Requests")).toBe("rate-limit");
  });

  test("the network", () => {
    expect(classifyGhError("error connecting to api.github.com")).toBe("network");
    expect(classifyGhError("dial tcp: lookup api.github.com: no such host")).toBe("network");
    expect(classifyGhError("net/http: TLS handshake timeout")).toBe("network");
    expect(classifyGhError("read: connection reset by peer")).toBe("network");
  });

  test("anything else is one call's own failure", () => {
    expect(classifyGhError("gh: Not Found (HTTP 404)")).toBeUndefined();
    expect(classifyGhError("HTTP 502: Bad Gateway")).toBeUndefined();
  });
});

describe("healthAfter: one pause for every watch, growing while it keeps failing", () => {
  test("a rate limit pauses 5 minutes, then 10, at most 30", () => {
    const first = healthAfter(undefined, "rate-limit", NOW);
    expect(first).toEqual({ kind: "rate-limit", until: NOW + 5 * 60_000, failures: 1 });
    expect(healthAfter(first, "rate-limit", NOW)!.until).toBe(NOW + 10 * 60_000);
    expect(healthAfter({ kind: "rate-limit", until: NOW, failures: 9 }, "rate-limit", NOW)!.until).toBe(NOW + 30 * 60_000);
  });

  test("the network pauses 30 seconds, doubling up to 5 minutes", () => {
    expect(healthAfter(undefined, "network", NOW)!.until).toBe(NOW + 30_000);
    expect(healthAfter({ kind: "network", until: NOW, failures: 9 }, "network", NOW)!.until).toBe(NOW + 5 * 60_000);
  });

  test("a call that works clears it", () => {
    expect(healthAfter({ kind: "network", until: NOW, failures: 3 }, "ok", NOW)).toBeUndefined();
  });
});

describe("pausedText: what the panel and a refused call say", () => {
  test("why, and when it tries again", () => {
    const health: GithubHealth = { kind: "rate-limit", until: Date.parse("2026-11-18T12:05:00Z"), failures: 1 };
    expect(pausedText(health, NOW)).toMatch(/^GitHub is rate limiting; checking again at \d\d:05$/);
    expect(pausedText({ ...health, kind: "network" }, NOW)).toMatch(/^GitHub can't be reached; checking again at \d\d:05$/);
    expect(pausedText({ ...health, until: NOW - 1 }, NOW)).toBeUndefined();
  });
});
