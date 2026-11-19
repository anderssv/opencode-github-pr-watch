import { describe, expect, test } from "bun:test";
import { automaticStartAllowed, keepConcurrentChanges, dropUnwatched, freshTrigger, isOrphaned, keepExisting, stillWanted } from "../core/lifecycle";
import { aWatch } from "./mothers";

const NOW = Date.parse("2026-11-17T10:00:00Z");
const MIN = 60_000;

describe("unwatch is remembered (plan 5)", () => {
  test("an automatic trigger doesn't restart a PR unwatched in this session", () => {
    expect(automaticStartAllowed({ automatic: true, unwatchedAt: NOW - 5 * MIN })).toBe(false);
  });

  test("an explicit watch_pr does, and so does a trigger for a PR never unwatched", () => {
    expect(automaticStartAllowed({ automatic: false, unwatchedAt: NOW - 5 * MIN })).toBe(true);
    expect(automaticStartAllowed({ automatic: true })).toBe(true);
  });
});

describe("an unwatch during a start wins (plan 5, team-docs#162)", () => {
  test("a start that began before the unwatch is dropped", () => {
    expect(stillWanted({ startedAt: NOW - 2_000, unwatchedAt: NOW - 1_000 })).toBe(false);
  });

  test("a start after the unwatch goes ahead", () => {
    expect(stillWanted({ startedAt: NOW, unwatchedAt: NOW - 1_000 })).toBe(true);
    expect(stillWanted({ startedAt: NOW })).toBe(true);
  });
});

describe("queued messages for an unwatched PR are dropped (plan 6)", () => {
  test("drops messages about PRs unwatched after they were queued, keeps the rest", () => {
    const messages = ["o/r#1: approved", "o/r#2: merged"];
    expect(dropUnwatched(messages, new Map([["o/r#1", NOW]]))).toEqual(["o/r#2: merged"]);
  });
});

describe("orphaned watches are taken over (plan 30)", () => {
  test("a watch pinned elsewhere that nobody has checked for 15 minutes", () => {
    const watch = { ...aWatch(), pinned: { providerID: "p", directory: "/other" }, lastCheckedAt: NOW - 16 * MIN };
    expect(isOrphaned(watch, "/mine", NOW)).toBe(true);
  });

  test("not when it is recent, or pinned to this directory (which polls it anyway)", () => {
    expect(isOrphaned({ ...aWatch(), pinned: { providerID: "p", directory: "/other" }, lastCheckedAt: NOW - 5 * MIN }, "/mine", NOW)).toBe(false);
    expect(isOrphaned({ ...aWatch(), pinned: { providerID: "p", directory: "/mine" }, lastCheckedAt: NOW - 60 * MIN }, "/mine", NOW)).toBe(false);
  });
});

describe("a trigger from a long command is stale (plan 7)", () => {
  test("kept when the command finished within 5 minutes", () => {
    expect(freshTrigger("rerun", { startedAt: NOW - 30_000, finishedAt: NOW })).toBe("rerun");
  });

  test("dropped after a long command (gh run rerun …; gh run watch …), and when the start is unknown it is kept", () => {
    expect(freshTrigger("rerun", { startedAt: NOW - 40 * MIN, finishedAt: NOW })).toBeUndefined();
    expect(freshTrigger("update-branch", { finishedAt: NOW })).toBe("update-branch");
  });
});

describe("an automatic trigger on a PR already watched in the session keeps that watch (plan 12)", () => {
  test("kept for automatic triggers in the same session", () => {
    expect(keepExisting({ automatic: true, sessionID: "s1", existing: { sessionID: "s1" } })).toBe(true);
  });

  test("replaced by an explicit watch_pr, or from another session; nothing to keep without one", () => {
    expect(keepExisting({ automatic: false, sessionID: "s1", existing: { sessionID: "s1" } })).toBe(false);
    expect(keepExisting({ automatic: true, sessionID: "s2", existing: { sessionID: "s1" } })).toBe(false);
    expect(keepExisting({ automatic: true, sessionID: "s1" })).toBe(false);
  });
});

describe("keepConcurrentChanges: what was added to a watch while it was being checked survives the check's save", () => {
  const before = aWatch({ runs: [1] });

  test("a run attached during the check is kept; one the check saw finish stays gone", () => {
    const stored = { ...before, runs: [1, 2] };
    const checked = { ...before, runs: [] as number[] };
    expect(keepConcurrentChanges(before, stored, checked).runs).toEqual([2]);
  });

  test("a trigger's grace and expected commit set during the check are kept", () => {
    const stored = { ...before, awaiting: { trigger: "rerun" as const, since: NOW }, expectedCommitSince: NOW };
    const result = keepConcurrentChanges(before, stored, before);
    expect([result.awaiting, result.expectedCommitSince]).toEqual([{ trigger: "rerun", since: NOW }, NOW]);
  });

  test("nothing changed meanwhile: the check's result as it is", () => {
    const checked = { ...before, runs: [] as number[], lastSnapshot: "new" };
    expect(keepConcurrentChanges(before, before, checked)).toEqual(checked);
  });
});
