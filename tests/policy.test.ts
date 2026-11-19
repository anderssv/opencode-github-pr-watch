import { describe, expect, test } from "bun:test";
import { nextStep } from "../core/pr-facts";
import { approvalText, approvalWait, endReason, overdue, problemOf, events, phaseOf, pollDelay, reminderDue, startDecision, stillAwaiting, stuckJobs, workingMs, type EndInput, alignedDelay } from "../core/policy";
import type { PrFacts } from "../core/pr-facts";
import { suggestionFor } from "../core/advice";
import { aFacts } from "./mothers";

const NOW = Date.parse("2026-10-15T10:30:00Z"); // a Thursday: reminders and review limits count working days
const merged = (overrides = {}) => aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING", ...overrides });

describe("events", () => {
  test("nothing on the first look", () => {
    expect(events(undefined, aFacts(), NOW)).toEqual([]);
  });

  test("nothing when nothing that matters changed", () => {
    expect(events(aFacts(), aFacts(), NOW)).toEqual([]);
  });

  test.each([
    [{ review: "REVIEW_REQUIRED" }, { review: "APPROVED" }, "approved"],
    [{ review: "REVIEW_REQUIRED" }, { review: "CHANGES_REQUESTED" }, "changes requested"],
    [{ review: "APPROVED" }, { review: "REVIEW_REQUIRED" }, "approval dismissed, review required again"],
    [{ checks: "PENDING" }, { checks: "FAIL", failingChecks: ["Trivy"] }, "checks failing: Trivy"],
    [{ branch: "OK" }, { branch: "BEHIND" }, "behind main, needs update"],
    [{ branch: "OK" }, { branch: "CONFLICT" }, "conflicts with main"],
    [{}, { state: "CLOSED" }, "closed without merging"],
  ] as const)("%o -> %o: %s", (before, after, event) => {
    expect(events(aFacts(before), aFacts(after), NOW)).toEqual([event]);
  });

  test("a new commit is its own event, and covers the dismissed approval", () => {
    const before = aFacts({ headSha: "aaaaaaa111", review: "APPROVED" });
    const after = aFacts({ headSha: "bbbbbbb222", review: "REVIEW_REQUIRED", checks: "PENDING" });

    expect(events(before, after, NOW)).toEqual(["new commit bbbbbbb — checks restarted, approval may be dismissed"]);
  });

  test("names the bot on a bot PR, as a fact", () => {
    const after = aFacts({ headSha: "bbbbbbb222", author: "app/dependabot", authorIsBot: true });

    expect(events(aFacts({ headSha: "aaaaaaa111" }), after, NOW)).toEqual([
      "new commit bbbbbbb (bot PR by app/dependabot) — checks restarted, approval may be dismissed",
    ]);
  });

  test("back up to date", () => {
    expect(events(aFacts({ branch: "BEHIND" }), aFacts({ branch: "OK" }), NOW)).toEqual(["back up to date with main"]);
  });

  test("auto-merge turned on or off is a fact, with who did it when known", () => {
    expect(events(aFacts(), aFacts({ autoMerge: true, autoMergeBy: "octocat" }), NOW)).toEqual(["auto-merge enabled by octocat"]);
    expect(events(aFacts({ autoMerge: true }), aFacts({ autoMerge: false }), NOW)).toEqual(["auto-merge disabled"]);
  });

  test("a check starts waiting for an environment approval", () => {
    const before = aFacts({ checks: "PENDING" });
    const after = aFacts({ checks: "PENDING", waitingChecks: ["CORE terraform / Plan", "LAB / Plan"] });

    expect(events(before, after, NOW)).toEqual(["run approval needed (checks): CORE terraform / Plan, LAB / Plan"]);
  });

  test("a check that was already waiting isn't news again", () => {
    const waiting = aFacts({ checks: "PENDING", waitingChecks: ["Plan"] });

    expect(events(waiting, { ...waiting }, NOW)).toEqual([]);
  });

  test("merged", () => {
    expect(events(aFacts(), merged({ deploy: "NO_RUNS" }), NOW)).toEqual(["merged"]);
  });

  test.each([
    [{ deploy: "NO_RUNS" }, { deploy: "RUNNING" }, "deploy started"],
    [{ deploy: "RUNNING" }, { deploy: "WAITING", waitingJobs: ["DEPLOY - Prod"] }, "run approval needed (deploy): DEPLOY - Prod"],
    [{ deploy: "RUNNING" }, { deploy: "FAILED" }, "deploy failed"],
    [{ deploy: "RUNNING" }, { deploy: "SUCCEEDED" }, "deployed (merge pipeline succeeded)"],
  ] as const)("deploy %o -> %o: %s", (before, after, event) => {
    expect(events(merged(before), merged(after), NOW)).toEqual([event]);
  });

  test("merged with no deploy starting in time", () => {
    const before = merged({ deploy: "NO_RUNS", mergedAt: NOW - 10 * 60_000 });
    const after = merged({ deploy: "NO_RUNS", mergedAt: NOW - 20 * 60_000 });

    expect(events(before, after, NOW)).toEqual(["merged, but no deploy started for the merge commit"]);
  });

  test("several events at once", () => {
    expect(events(aFacts({ review: "REVIEW_REQUIRED" }), merged({ deploy: "RUNNING" }), NOW)).toEqual([
      "approved",
      "merged",
      "deploy started",
    ]);
  });
});

const end = (facts: PrFacts, more: Partial<EndInput> = {}) => endReason(facts, { phaseSince: NOW, now: NOW, ...more });

describe("phaseOf: a watch follows the PR until it is done", () => {
  test.each([
    [aFacts({ review: "REVIEW_REQUIRED" }), "review"],
    [aFacts({ checks: "PENDING" }), "checks"],
    [aFacts({ autoMerge: true }), "auto-merge"],
    [aFacts({ autoMerge: true, branch: "BEHIND" }), "auto-update"],
    [merged({ deploy: "NO_RUNS" }), "deploy"],
    [merged({ deploy: "RUNNING" }), "deploy"],
    [merged({ deploy: "WAITING" }), "approval"],
    [aFacts(), "ready"],
    [aFacts({ draft: true }), "waiting"],
  ])("%o is still going: %s", (facts, phase) => {
    expect(phaseOf(facts, NOW)).toMatchObject({ phase });
  });

  test.each([
    [aFacts({ branch: "BEHIND" })],
    [aFacts({ review: "CHANGES_REQUESTED" })],
    [aFacts({ checks: "FAIL", failingChecks: ["Trivy"] })],
    [aFacts({ autoMerge: true, checks: "FAIL", failingChecks: ["Build"] })],
    [aFacts({ branch: "CONFLICT" })],
    [merged({ deploy: "FAILED" })],
  ])("%o has something to fix: the watch keeps following it", (facts) => {
    expect(phaseOf(facts, NOW)).toEqual({ phase: "fix" });
  });

  test.each([
    [aFacts({ state: "CLOSED" }), "closed without merging"],
    [merged({ deploy: "SUCCEEDED" }), "deployed"],
    [merged({ deploy: "NO_RUNS", mergedAt: NOW - 3_600_000 }), "no deploy started"],
  ])("%o is done: %s", (facts, reason) => {
    expect(phaseOf(facts, NOW)).toEqual({ end: expect.stringContaining(reason) });
  });

  test("what is wrong, for the message when something has to be fixed", () => {
    expect(problemOf(aFacts({ checks: "FAIL", failingChecks: ["Trivy"] }), NOW)).toContain("checks failed: Trivy");
    expect(problemOf(merged({ deploy: "FAILED" }), NOW)).toContain("merge pipeline failed");
    expect(problemOf(aFacts({ branch: "BEHIND" }), NOW)).toBe("behind main");
    expect(problemOf(aFacts({ review: "REVIEW_REQUIRED" }), NOW)).toBeUndefined();
  });
});

describe("endReason", () => {
  test("merged in a repo where nothing a merge starts deploys: says so", () => {
    expect(end(aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "NO_RUNS", deployPossible: false }))).toContain(
      "merged; nothing that starts on a merge deploys in this repo",
    );
  });

  test("ends where phaseOf ends", () => {
    expect(end(aFacts({ state: "CLOSED" }))).toContain("closed");
  });

  test("waiting on a person or a fix has no time limit of its own", () => {
    for (const facts of [aFacts(), aFacts({ review: "REVIEW_REQUIRED" }), aFacts({ checks: "FAIL", failingChecks: ["Build"] })]) {
      expect(end(facts, { phaseSince: NOW - 10 * 86_400_000, lastChangeAt: NOW - 10 * 86_400_000 })).toBeUndefined();
    }
  });

  test("a watch where nothing has changed for 14 days ends", () => {
    expect(end(aFacts({ review: "REVIEW_REQUIRED" }), { lastChangeAt: NOW - 15 * 86_400_000 })).toBe("nothing changed for 14 days; call watch_pr again to keep watching");
  });

  test("auto-merge on a PR that is ready ends after 10 minutes, since GitHub merges within a minute or two (plan 10, platform#2328)", () => {
    expect(overdue(aFacts({ autoMerge: true }), { phaseSince: NOW - 11 * 60_000, now: NOW })).toContain("approved and checks pass, but auto-merge hasn't merged after 10 minutes");
    expect(overdue(aFacts({ autoMerge: true }), { phaseSince: NOW - 9 * 60_000, now: NOW })).toBeUndefined();
    expect(end(aFacts({ autoMerge: true }), { phaseSince: NOW - 11 * 60_000 })).toBeUndefined();
    expect(suggestionFor(aFacts({ autoMerge: true }), NOW)).toBe("merge it directly (gh pr merge)");
  });

  test("auto-merge waiting for an earlier deploy keeps the pipeline limit", () => {
    expect(overdue(aFacts({ autoMerge: true, deployingOnBase: ["MAIN"] }), { phaseSince: NOW - 29 * 60_000, now: NOW })).toBeUndefined();
  });

  test.each([
    [aFacts({ checks: "PENDING" }), 31, "checks still running after 30 minutes"],
    [aFacts({ autoMerge: true, branch: "BEHIND" }), 31, "behind main for 30 minutes"],
    [merged({ deploy: "RUNNING" }), 31, "deploy still running after 30 minutes"],
  ])("pipeline phases are overdue after 30 minutes in that phase, and the watch goes on", (facts, minutes, reason) => {
    expect(overdue(facts, { phaseSince: NOW - minutes * 60_000, now: NOW })).toContain(reason);
    expect(overdue(facts, { phaseSince: NOW - 29 * 60_000, now: NOW })).toBeUndefined();
    expect(end(facts, { phaseSince: NOW - minutes * 60_000 })).toBeUndefined();
  });

  test("the pipeline limit can be configured", () => {
    expect(overdue(aFacts({ checks: "PENDING" }), { phaseSince: NOW - 45 * 60_000, now: NOW, pipelineLimitMs: 60 * 60_000 })).toBeUndefined();
  });

  test("waiting for review has no time limit", () => {
    expect(end(aFacts({ review: "REVIEW_REQUIRED" }), { phaseSince: NOW - 30 * 86_400_000 })).toBeUndefined();
  });

  test("waiting on a person or a fix is never overdue", () => {
    expect(overdue(aFacts({ review: "REVIEW_REQUIRED" }), { phaseSince: NOW - 30 * 86_400_000, now: NOW })).toBeUndefined();
    expect(overdue(aFacts({ checks: "FAIL", failingChecks: ["B"] }), { phaseSince: NOW - 30 * 86_400_000, now: NOW })).toBeUndefined();
  });

  test("something to fix keeps the watch going, however long the fix takes", () => {
    for (const facts of [merged({ deploy: "FAILED" }), aFacts({ checks: "FAIL", failingChecks: ["Trivy"] }), aFacts({ branch: "BEHIND" })]) {
      expect(end(facts, { awaiting: { trigger: "update-branch", since: NOW - 60 * 60_000 } })).toBeUndefined();
      expect(end(facts, { phaseSince: NOW - 3 * 86_400_000 })).toBeUndefined();
    }
  });
});

describe("startDecision", () => {
  test("starts while the PR is still moving", () => {
    expect(startDecision(aFacts({ review: "REVIEW_REQUIRED" }), NOW).start).toBe(true);
  });

  test("a PR ready for merge is watched until it is merged", () => {
    expect(startDecision(aFacts(), NOW)).toEqual({ start: true });
  });

  test("does not start when a person has to act or it is done, and says why", () => {
    expect(startDecision(aFacts({ state: "CLOSED" }), NOW)).toEqual({ start: false, reason: expect.stringContaining("closed") });
    expect(startDecision(merged({ deploy: "SUCCEEDED" }), NOW)).toEqual({ start: false, reason: expect.stringContaining("deployed") });
  });

  test("starts on failing checks and waits for the next run", () => {
    expect(startDecision(aFacts({ checks: "FAIL", failingChecks: ["Trivy"] }), NOW)).toEqual({
      start: true,
      awaiting: { trigger: "failed-checks", since: NOW },
    });
  });

  test("starts on a behind PR and waits for it to be updated", () => {
    expect(startDecision(aFacts({ branch: "BEHIND" }), NOW)).toEqual({ start: true, awaiting: { trigger: "behind", since: NOW } });
  });

  test("what is wrong states facts only; the advice comes separately as a suggestion", () => {
    expect(problemOf(aFacts({ branch: "BEHIND", author: "app/dependabot" }), NOW)).toBe("behind main");
  });

  test("starts on a stale state right after update-branch", () => {
    expect(startDecision(aFacts({ checks: "FAIL", failingChecks: ["Scan"] }), NOW, { trigger: "update-branch" }).start).toBe(true);
    expect(startDecision(aFacts({ branch: "BEHIND" }), NOW, { trigger: "update-branch" }).start).toBe(true);
  });

  test("starts on a failed deploy when a rerun was just requested", () => {
    expect(startDecision(merged({ deploy: "FAILED" }), NOW, { trigger: "rerun" }).start).toBe(true);
  });

  test("an approved PR with a required check that never reported is not ready: it is watched", () => {
    const missing = aFacts({ checks: "MISSING", missingChecks: ["Build status - api-specs"] });

    expect(startDecision(missing, NOW)).toEqual({ start: true });
    expect(phaseOf(missing, NOW)).toEqual({ phase: "required-checks" });
  });

  test("a required check that still hasn't reported after the pipeline limit is overdue, naming it", () => {
    const missing = aFacts({ checks: "MISSING", missingChecks: ["Build status - api-specs"] });

    expect(overdue(missing, { phaseSince: NOW - 29 * 60_000, now: NOW })).toBeUndefined();
    expect(overdue(missing, { phaseSince: NOW - 31 * 60_000, now: NOW })).toContain(
      "required checks never reported after 30 minutes: Build status - api-specs",
    );
  });
});

describe("approval wait", () => {
  test("is named before and after the merge", () => {
    expect(approvalWait(aFacts({ checks: "PENDING", waitingChecks: ["Plan"] }))).toEqual({ kind: "checks", names: ["Plan"] });
    expect(approvalWait(aFacts({ state: "MERGED", mergedAt: NOW, deploy: "WAITING", waitingJobs: ["core / Deploy"] }))).toEqual({ kind: "deploy", names: ["core / Deploy"] });
    expect(approvalWait(aFacts())).toBeUndefined();
  });

  test("a watch that starts while already waiting still tells the user", () => {
    expect(approvalText({ kind: "deploy", names: ["core / Deploy"] })).toBe("run approval needed (deploy): core / Deploy");
    expect(approvalText({ kind: "checks", names: ["Plan"] })).toBe("run approval needed (checks): Plan");
  });

  test("waiting for an approval has no time limit, before the merge or for the deploy", () => {
    const gate = aFacts({ checks: "PENDING", waitingChecks: ["Plan"] });
    const deploy = merged({ deploy: "WAITING", waitingJobs: ["DEPLOY - Prod"] });

    expect(endReason(gate, { phaseSince: NOW - 30 * 86_400_000, now: NOW })).toBeUndefined();
    expect(phaseOf(deploy, NOW)).toEqual({ phase: "approval" });
    expect(endReason(deploy, { phaseSince: NOW - 30 * 86_400_000, now: NOW })).toBeUndefined();
    expect(reminderDue(deploy, NOW - 25 * 3_600_000, undefined, NOW)).toBe(true);
  });
});

describe("reminderDue", () => {
  const waiting = aFacts({ review: "REVIEW_REQUIRED" });

  test("reminds every 24 hours while waiting for review", () => {
    expect(reminderDue(waiting, NOW - 23 * 3_600_000, undefined, NOW)).toBe(false);
    expect(reminderDue(waiting, NOW - 25 * 3_600_000, undefined, NOW)).toBe(true);
    expect(reminderDue(waiting, NOW - 30 * 3_600_000, NOW - 2 * 3_600_000, NOW)).toBe(false);
  });

  test("reminds about an environment approval too, with its own phase", () => {
    const gate = aFacts({ checks: "PENDING", waitingChecks: ["Plan"] });

    expect(phaseOf(gate, NOW)).toEqual({ phase: "approval" });
    expect(reminderDue(gate, NOW - 25 * 3_600_000, undefined, NOW)).toBe(true);
    expect(pollDelay(gate, NOW)).toBe(30_000);
  });

  test("no reminders in other phases", () => {
    expect(reminderDue(aFacts({ checks: "PENDING" }), NOW - 25 * 3_600_000, undefined, NOW)).toBe(false);
  });
});

describe("pollDelay", () => {
  test.each([
    aFacts({ checks: "PENDING" }),
    aFacts({ review: "REVIEW_REQUIRED" }),
    aFacts({ checks: "PENDING", waitingChecks: ["Plan"] }),
    merged({ deploy: "RUNNING" }),
    merged({ deploy: "WAITING" }),
    aFacts({ autoMerge: true }),
  ])("every watch is checked every 30 seconds, whatever it waits for", (facts) => {
    expect(pollDelay(facts, NOW)).toBe(30_000);
  });

  test("a watch with no change for a day is checked every 5 minutes, unless a new run is expected", () => {
    const quiet = NOW - 25 * 3_600_000;
    expect(pollDelay(aFacts({ review: "REVIEW_REQUIRED" }), NOW, false, quiet)).toBe(5 * 60_000);
    expect(pollDelay(aFacts({ review: "REVIEW_REQUIRED" }), NOW, true, quiet)).toBe(30_000);
    expect(pollDelay(aFacts({ review: "REVIEW_REQUIRED" }), NOW, false, NOW - 3_600_000)).toBe(30_000);
  });
});

describe("stuckJobs", () => {
  test("names jobs unfinished for longer than the limit", () => {
    const facts = merged({
      unfinishedJobs: [
        { name: "DEPLOY - Prod", since: NOW - 50 * 60_000 },
        { name: "DEPLOY - Dev", since: NOW - 5 * 60_000 },
      ],
    });

    expect(stuckJobs(facts, NOW, 30 * 60_000)).toEqual(["DEPLOY - Prod (50 min)"]);
  });
});

describe("stillAwaiting", () => {
  test("keeps waiting while the PR is still in the state the trigger replaces", () => {
    expect(stillAwaiting({ trigger: "failed-checks", since: NOW }, aFacts({ checks: "FAIL" }), NOW)).toBe(true);
  });

  test("stops waiting as soon as a new run shows up", () => {
    expect(stillAwaiting({ trigger: "failed-checks", since: NOW }, aFacts({ checks: "PENDING" }), NOW)).toBe(false);
    expect(stillAwaiting({ trigger: "rerun", since: NOW }, merged({ deploy: "RUNNING" }), NOW)).toBe(false);
  });
});

describe("pollDelay while awaiting a new run", () => {
  test("checks every 30 seconds", () => {
    expect(pollDelay(aFacts({ checks: "FAIL" }), NOW, true)).toBe(30_000);
  });
});

describe("waiting for an earlier deploy", () => {
  test("is a phase, not an end, and is overdue after 30 minutes", () => {
    const facts = aFacts({ deployingOnBase: ["Audit Log Archive"] });

    expect(phaseOf(facts, NOW)).toEqual({ phase: "base-deploy" });
    expect(overdue(facts, { phaseSince: NOW - 31 * 60_000, now: NOW })).toContain("Audit Log Archive");
    expect(pollDelay(facts, NOW)).toBe(30_000);
  });
});

describe("alignedDelay", () => {
  test("polls land on the wall-clock grid, so watches started apart check together", () => {
    const minute = 60_000;
    const base = Date.parse("2026-10-14T10:00:00Z");
    expect(base + 13_000 + alignedDelay(base + 13_000, minute)).toBe(base + minute);
    expect(base + 40_000 + alignedDelay(base + 40_000, minute)).toBe(base + minute);
    expect(base + 2 * minute + alignedDelay(base + 2 * minute, 5 * minute)).toBe(base + 5 * minute);
  });

  test("never polls almost immediately again", () => {
    const base = Date.parse("2026-10-14T10:00:00Z");
    expect(alignedDelay(base + 59_000, 60_000)).toBe(61_000);
  });
});

describe("phaseOf: deploy pipeline not identified", () => {
  test("hands back, naming the workflows it saw", () => {
    const facts = aFacts({ state: "MERGED", mergedAt: NOW - 20 * 60_000, deploy: "UNIDENTIFIED", undeterminedWorkflows: ["Docs", "CodeQL"] });
    expect(phaseOf(facts, NOW)).toEqual({ phase: "fix" });
    expect(problemOf(facts, NOW)).toBe("couldn't tell which workflow deploys this repo (saw: Docs, CodeQL)");
  });
});

describe("deployed by a later run (plan 1)", () => {
  test("says which run deployed it", () => {
    const facts = aFacts({ state: "MERGED", mergedAt: 0, deploy: "SUCCEEDED", deployedBy: { title: "Bump ktor (#2328)", url: "u" } });
    expect(phaseOf(facts, 1)).toEqual({ end: "deployed by the run of Bump ktor (#2328) (u), which includes this merge; this PR's own run failed" });
    expect(events(aFacts({ state: "MERGED", mergedAt: 0, deploy: "RUNNING" }), facts, 1)).toEqual(["deployed by the run of Bump ktor (#2328) (u), which includes this merge; this PR's own run failed"]);
  });
});

describe("deploy blocked behind a run waiting for approval (plan 2)", () => {
  test("ends with the blocking run, since a person has to approve or cancel it", () => {
    const facts = aFacts({ state: "MERGED", mergedAt: 0, deploy: "BLOCKED", blockedBy: { title: "Apply bass Team (#751)", url: "u", since: Date.parse("2026-10-04T08:00:00Z") } });
    expect(phaseOf(facts, 1)).toEqual({ phase: "waiting" });
    expect(problemOf(facts, 1)).toBe("deploy queued behind the run of Apply bass Team (#751) (u), waiting for approval (that run started 2026-10-04 08:00 UTC)");
  });
});

describe("review waiting counts working days only (plan 24, registry#1273)", () => {
  const waiting = aFacts({ review: "REVIEW_REQUIRED" });
  const at = (s: string) => new Date(s).getTime(); // local time
  const HOUR = 3_600_000;

  test("working time skips Saturday and Sunday", () => {
    expect(workingMs(at("2026-11-13T12:00"), at("2026-11-16T12:00"))).toBe(24 * HOUR); // Friday noon → Monday noon
    expect(workingMs(at("2026-11-16T09:00"), at("2026-11-16T12:00"))).toBe(3 * HOUR);
  });

  test("no reminder on a weekend, and none for the weekend's hours on Monday", () => {
    expect(reminderDue(waiting, at("2026-11-13T12:00"), undefined, at("2026-11-14T13:00"))).toBe(false); // Saturday
    expect(reminderDue(waiting, at("2026-11-13T12:00"), undefined, at("2026-11-15T13:00"))).toBe(false); // Sunday
    expect(reminderDue(waiting, at("2026-11-13T12:00"), undefined, at("2026-11-16T11:00"))).toBe(false); // 23 working hours
    expect(reminderDue(waiting, at("2026-11-13T12:00"), undefined, at("2026-11-16T12:30"))).toBe(true);
  });

});

describe("failure ends name the run (plan 16)", () => {
  const failedRun = { workflow: "MAIN", url: "https://github.com/o/r/actions/runs/5" };
  test("failed checks and a failed deploy", () => {
    expect(problemOf(aFacts({ checks: "FAIL", failingChecks: ["Build"], failedRun }), NOW)).toBe("checks failed: Build (MAIN, https://github.com/o/r/actions/runs/5)");
    expect(problemOf(merged({ deploy: "FAILED", failedRun }), NOW)).toBe("the merge pipeline failed (MAIN, https://github.com/o/r/actions/runs/5)");
  });
});

describe("a failed deploy names its failed jobs (plan 17)", () => {
  test("after the run", () => {
    const facts = merged({ deploy: "FAILED", failedRun: { workflow: "Terraform Organizations", url: "u", jobs: ["Apply acme Organization"] } });
    expect(problemOf(facts, NOW)).toBe("the merge pipeline failed (Terraform Organizations, u): Apply acme Organization");
  });
});

describe("PR checks queued behind other runs waiting for run approval (infra#752)", () => {
  const blockedChecks = [
    { workflow: "BICEP - Deploy", title: "chore(deps): bump workflows", url: "https://github.com/o/r/actions/runs/1", since: 0 },
    { workflow: "TERRAFORM - Apply", title: "Alert on failing logins", url: "https://github.com/o/r/actions/runs/2", since: 0 },
  ];
  // Queued runs have no jobs yet, so no check runs: GitHub shows the checks as passing (live on #752).
  const facts = aFacts({ checks: "PASS", review: "REVIEW_REQUIRED", blockedChecks });

  test("a step of its own, waiting on people without a time limit", () => {
    expect(nextStep(facts, NOW)).toBe("CHECKS_BLOCKED");
    expect(phaseOf(facts, NOW)).toEqual({ phase: "approval" });
    expect(endReason(facts, { phaseSince: NOW - 10 * 86_400_000, now: NOW })).toBeUndefined();
  });

  test("said once when it starts, with the runs ahead and their links", () => {
    expect(events(aFacts({ checks: "PASS", review: "REVIEW_REQUIRED" }), facts, NOW)).toEqual([
      "checks queued behind runs waiting for run approval: BICEP - Deploy behind chore(deps): bump workflows (https://github.com/o/r/actions/runs/1); TERRAFORM - Apply behind Alert on failing logins (https://github.com/o/r/actions/runs/2)",
    ]);
    expect(events(facts, facts, NOW)).toEqual([]);
  });
});

describe("pollDelay with a run followed on the PR", () => {
  const NOW_ = Date.parse("2026-11-19T10:00:00Z");
  const waitingForReview = { review: "REVIEW_REQUIRED" as const };

  test("every 30 seconds while the run goes, and after it has finished", () => {
    const running = aFacts({ ...waitingForReview, attachedRuns: [{ run: 1, workflow: "MAIN", state: "RUNNING", url: "u" }] });
    const done = aFacts({ ...waitingForReview, attachedRuns: [{ run: 1, workflow: "MAIN", state: "SUCCEEDED", url: "u" }] });
    expect(pollDelay(running, NOW_)).toBe(30_000);
    expect(pollDelay(done, NOW_)).toBe(pollDelay(aFacts(waitingForReview), NOW_));
  });
});
