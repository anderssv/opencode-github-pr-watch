import { describe, expect, test } from "bun:test";
import { progressTrack, trackText } from "../core/progress";
import { aFacts } from "./mothers";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const merged = (overrides = {}) => aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING", ...overrides });
const states = (facts: Parameters<typeof aFacts>[0]) => progressTrack(aFacts(facts), NOW).map((s) => `${s.name}:${s.state}${s.detail ? `(${s.detail})` : ""}`);

describe("progressTrack: one line of stages for a PR, each done, running, waiting on a person, failed or upcoming", () => {
  test("checks running, then a review waiting", () => {
    expect(states({ checks: "PENDING", checksProgress: { done: 3, total: 5, current: "Build" }, review: "REVIEW_REQUIRED" })).toEqual([
      "PR:done", "Checks:running(3/5 · Build)", "Review:upcoming", "Merge:upcoming", "Deploy:upcoming",
    ]);
    expect(states({ review: "REVIEW_REQUIRED" })).toEqual(["PR:done", "Checks:done", "Review:waiting(waiting for code review)", "Merge:upcoming", "Deploy:upcoming"]);
  });

  test("approvals are yellow on the step they hold up: a check run before the merge, the deploy after it", () => {
    expect(states({ checks: "PENDING", waitingChecks: ["Plan prod"], review: "REVIEW_REQUIRED" })[1]).toBe("Checks:waiting(run approval: Plan prod)");
    expect(progressTrack(merged({ deploy: "WAITING", waitingJobs: ["DEPLOY - Prod"] }), NOW).at(-1)).toEqual({ name: "Deploy", state: "waiting", detail: "run approval: DEPLOY - Prod" });
  });

  test("ready, merged, deploying, deployed", () => {
    expect(states({})).toEqual(["PR:done", "Checks:done", "Review:done", "Merge:waiting(ready to merge)", "Deploy:upcoming"]);
    expect(states({ autoMerge: true })[3]).toBe("Merge:running(auto-merge)");
    expect(progressTrack(merged({ deployProgress: { done: 6, total: 7, current: "DEPLOY - Prod" } }), NOW).slice(3).map((s) => [s.state, s.detail])).toEqual([
      ["done", undefined], ["running", "6/7 · DEPLOY - Prod"],
    ]);
    expect(progressTrack(merged({ deploy: "SUCCEEDED" }), NOW).every((s) => s.state === "done")).toBe(true);
  });

  test("what fails is red on its step", () => {
    expect(states({ checks: "FAIL", failingChecks: ["Build"] })[1]).toBe("Checks:failed(Build)");
    expect(states({ review: "CHANGES_REQUESTED" })[2]).toBe("Review:failed(changes requested)");
    expect(states({ branch: "CONFLICT" })[0]).toBe("PR:failed(conflicts with main)");
    expect(states({ branch: "BEHIND" })[0]).toBe("PR:failed(behind main)");
    expect(progressTrack(merged({ deploy: "FAILED" }), NOW).at(-1)).toEqual({ name: "Deploy", state: "failed" });
  });

  test("a draft waits on the PR step; no deploy step where nothing deploys", () => {
    expect(states({ draft: true })[0]).toBe("PR:waiting(draft)");
    expect(progressTrack(merged({ deploy: "NO_RUNS", deployPossible: false }), NOW).map((s) => s.name)).toEqual(["PR", "Checks", "Review", "Merge"]);
  });
});

describe("trackText: the track in a message", () => {
  test("a mark per state, details where there are some", () => {
    const text = trackText(progressTrack(merged({ deployProgress: { done: 6, total: 7, current: "DEPLOY - Prod" } }), NOW));
    expect(text).toBe("PR ✓ · Checks ✓ · Review ✓ · Merge ✓ · Deploy … 6/7 · DEPLOY - Prod");
    expect(trackText(progressTrack(aFacts({ review: "REVIEW_REQUIRED" }), NOW))).toBe("PR ✓ · Checks ✓ · Review ⏸ waiting for code review · Merge · Deploy");
  });
});

describe("the expected deploy, before the merge", () => {
  test("its jobs and the environments that need approval, on the upcoming Deploy stage", () => {
    const facts = aFacts({ review: "REVIEW_REQUIRED", expectedDeploy: { jobs: ["Build", "Dev", "Prod"], approval: ["prod"] } });
    expect(progressTrack(facts, NOW).at(-1)).toEqual({ name: "Deploy", state: "upcoming", detail: "3 jobs: Build, Dev, Prod · run approval for prod" });
  });

  test("after the merge, what is happening replaces what was expected", () => {
    const facts = merged({ deployProgress: { done: 1, total: 3, current: "Dev" }, expectedDeploy: { jobs: ["Build", "Dev", "Prod"], approval: [] } });
    expect(progressTrack(facts, NOW).at(-1)).toEqual({ name: "Deploy", state: "running", detail: "1/3 · Dev" });
  });
});

describe("the expected approval on the PR's checks", () => {
  test("said on the Checks stage while they run, before they reach it", () => {
    const facts = aFacts({ checks: "PENDING", checksProgress: { done: 2, total: 5 }, expectedChecksApproval: ["prod"] });
    expect(progressTrack(facts, NOW)[1]).toEqual({ name: "Checks", state: "running", detail: "2/5 · run approval for prod" });
  });

  test("once a run waits, what it waits for replaces the expectation", () => {
    const facts = aFacts({ checks: "PENDING", waitingChecks: ["Plan prod"], expectedChecksApproval: ["prod"] });
    expect(progressTrack(facts, NOW)[1]).toEqual({ name: "Checks", state: "waiting", detail: "run approval: Plan prod" });
  });
});
