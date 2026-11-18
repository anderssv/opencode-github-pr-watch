import { describe, expect, test } from "bun:test";
import { sessionGroups, watchRows } from "../core/watch-rows";
import { aFacts, aWatch } from "./mothers";

const NOW = Date.parse("2026-11-13T10:00:00Z");

describe("watchRows", () => {
  test("one row per watch in the session, with its link, title and where it is", () => {
    const watch = { ...aWatch(), id: "o/r#7", repo: "o/r", pr: 7, sessionID: "s1", lastSnapshot: "PR: Bump foo (https://github.com/o/r/pull/7)\nsummary: x", lastFacts: aFacts({ checks: "PENDING" }) };
    const other = { ...aWatch(), id: "o/r#8", sessionID: "s2" };

    expect(watchRows([watch, other], "s1", NOW)).toEqual([
      { id: "o/r#7", label: "o/r#7 Bump foo", url: "https://github.com/o/r/pull/7", detail: "checks running", tone: "pending", state: "OPEN", track: expect.any(Array) },
    ]);
  });

  test("tone says whether it's waiting on a person, running, or failed", () => {
    const row = (facts: Parameters<typeof aFacts>[0]) => watchRows([{ ...aWatch(), sessionID: "s1", lastFacts: aFacts(facts) }], "s1", NOW)[0]!;
    expect(row({ review: "REVIEW_REQUIRED" })).toMatchObject({ detail: "waiting for code review", tone: "waiting" });
    expect(row({ checks: "FAIL", failingChecks: ["Build"] })).toMatchObject({ detail: "checks failed: Build", tone: "failed" });
    expect(row({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING" })).toMatchObject({ detail: "deploying", tone: "pending" });
  });

  test("not checked yet", () => {
    const { lastFacts: _f, ...unchecked } = { ...aWatch(), sessionID: "s1" };
    expect(watchRows([unchecked], "s1", NOW)[0]).toMatchObject({ detail: "not checked yet", tone: "pending" });
  });
});

describe("watchRows: the run link", () => {
  test("comes from the stored facts", () => {
    const row = watchRows([{ ...aWatch(), sessionID: "s1", lastFacts: aFacts({ runUrl: "https://github.com/o/r/actions/runs/2" }) }], "s1", NOW)[0]!;
    expect(row.runUrl).toBe("https://github.com/o/r/actions/runs/2");
  });
});

describe("watchRows: progress", () => {
  const row = (facts: Parameters<typeof aFacts>[0]) => watchRows([{ ...aWatch(), sessionID: "s1", lastFacts: aFacts(facts) }], "s1", NOW)[0]!;

  test("checks and deploys show how far they've got", () => {
    expect(row({ checks: "PENDING", checksProgress: { done: 2, total: 7 } }).detail).toBe("checks running 2/7");
    expect(row({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING", deployProgress: { done: 4, total: 6 } }).detail).toBe("deploying 4/6");
    expect(row({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING", deployProgress: { done: 3, total: 4, current: "DEPLOY - Prod" } }).detail)
      .toBe("deploying 3/4 · DEPLOY - Prod");
  });
});

describe("watchRows: a required check that hasn't reported", () => {
  test("says which check it is waiting for, instead of 'checks running'", () => {
    const row = watchRows(
      [{ ...aWatch(), sessionID: "s1", lastFacts: aFacts({ checks: "MISSING", missingChecks: ["Build status - api-specs"], checksProgress: { done: 12, total: 12 } }) }],
      "s1",
      NOW,
    )[0]!;
    expect(row.detail).toBe("12 checks done; required check not reported: Build status - api-specs");
  });
});

describe("watchRows: everything counted is done", () => {
  test("says how many are done instead of N/N", () => {
    const row = (facts: Parameters<typeof aFacts>[0]) => watchRows([{ ...aWatch(), sessionID: "s1", lastFacts: aFacts(facts) }], "s1", NOW)[0]!;
    expect(row({ checks: "PENDING", checksProgress: { done: 17, total: 17 } }).detail).toBe("checks running, 17 done");
    expect(row({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING", deployProgress: { done: 4, total: 4 } }).detail).toBe("deploying, 4 steps done");
  });
});


describe("sessionGroups: every session's watches, for the side panel", () => {
  test("grouped by session, the session with the most recently started watch first", () => {
    const watches = [
      aWatch({ id: "o/r#1", sessionID: "s1", startedAt: 100 }),
      aWatch({ id: "o/r#2", sessionID: "s2", startedAt: 300 }),
      aWatch({ id: "o/r#3", sessionID: "s1", startedAt: 200 }),
    ];
    const groups = sessionGroups(watches, NOW);
    expect(groups.map((g) => g.sessionID)).toEqual(["s2", "s1"]);
    expect(groups[1]!.watches.map((w) => w.id)).toEqual(["o/r#1", "o/r#3"]);
  });

  test("no watches, no sessions", () => {
    expect(sessionGroups([], NOW)).toEqual([]);
  });
});

describe("code review and run approval are told apart", () => {
  const row = (facts: Parameters<typeof aFacts>[0]) => watchRows([aWatch({ lastFacts: aFacts(facts) })], aWatch().sessionID, NOW)[0]!;

  test("code review", () => {
    expect(row({ review: "REVIEW_REQUIRED" })).toMatchObject({ detail: "waiting for code review", waitingFor: "code-review" });
  });

  test("run approval: checks, deploy, and a run attached to the PR, which goes first", () => {
    expect(row({ checks: "PENDING", waitingChecks: ["Plan prod"] })).toMatchObject({ detail: "run approval needed: Plan prod", waitingFor: "run-approval" });
    expect(row({ state: "MERGED", mergedAt: NOW, deploy: "WAITING", waitingJobs: ["DEPLOY - Prod"] })).toMatchObject({ detail: "run approval needed: DEPLOY - Prod", waitingFor: "run-approval" });
    const attached = { run: 9, workflow: "MAIN", url: "u", state: "WAITING" as const, waitingJobs: ["DEPLOY - Prod"] };
    expect(row({ review: "REVIEW_REQUIRED", attachedRuns: [attached] })).toMatchObject({
      detail: "run approval needed: MAIN (DEPLOY - Prod) · waiting for code review", waitingFor: "run-approval", tone: "waiting",
    });
  });
});

describe("checks queued behind other runs", () => {
  test("the row says what they wait for, as run approval, with a link to each run ahead", () => {
    const facts = aFacts({
      checks: "PASS",
      review: "REVIEW_REQUIRED",
      blockedChecks: [
        { workflow: "BICEP - Deploy", title: "chore(deps): bump", url: "u1", since: 0 },
        { workflow: "TERRAFORM - Apply", title: "Alert when resets fail", url: "u2", since: 0 },
      ],
    });
    const [row] = watchRows([aWatch({ lastFacts: facts })], aWatch().sessionID, NOW);
    expect(row).toMatchObject({
      detail: "checks queued behind runs waiting for run approval: BICEP - Deploy (behind chore(deps): bump), TERRAFORM - Apply (behind Alert when resets fail) · waiting for code review",
      tone: "waiting",
      waitingFor: "run-approval",
      runUrl: "u1",
      runLinks: [
        { label: "Open the run ahead of BICEP - Deploy", url: "u1" },
        { label: "Open the run ahead of TERRAFORM - Apply", url: "u2" },
      ],
    });
  });
});

describe("rows carry the PR's progress track", () => {
  test("from the last check's facts", () => {
    const [row] = watchRows([{ ...aWatch(), sessionID: "s1", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) }], "s1", NOW);
    expect(row!.track?.map((s) => s.name)).toEqual(["PR", "Checks", "Review", "Merge", "Deploy"]);
    expect(row!.track?.[2]).toEqual({ name: "Review", state: "waiting", detail: "waiting for code review" });
  });
});
