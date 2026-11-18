import { describe, expect, test } from "bun:test";
import { progressTrack, trackText } from "../core/progress";
import { aFacts } from "./mothers";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const merged = (overrides = {}) => aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING", ...overrides });
const states = (facts: Parameters<typeof aFacts>[0]) => progressTrack(aFacts(facts), NOW).map((s) => `${s.name}:${s.state}${s.detail ? `(${s.detail})` : ""}`);

describe("progressTrack: one line of stages for a PR, each done, running, waiting on a person, failed or upcoming", () => {
  test("checks running, then a review waiting", () => {
    expect(states({ checks: "PENDING", checksProgress: { done: 3, total: 5, current: "Build" }, review: "REVIEW_REQUIRED" })).toEqual([
      "Checks:running(3/5 · Build)", "Review:upcoming", "Merge:upcoming", "Deploy:upcoming",
    ]);
    expect(states({ review: "REVIEW_REQUIRED" })).toEqual(["Checks:done", "Review:waiting(waiting for code review)", "Merge:upcoming", "Deploy:upcoming"]);
  });

  test("approvals are yellow on the step they hold up: a check run before the merge, the deploy after it", () => {
    expect(states({ checks: "PENDING", waitingChecks: ["Plan prod"], review: "REVIEW_REQUIRED" })[0]).toBe("Checks:waiting(run approval: Plan prod)");
    expect(progressTrack(merged({ deploy: "WAITING", waitingJobs: ["DEPLOY - Prod"] }), NOW).at(-1)).toEqual({ name: "Deploy", state: "waiting", detail: "run approval: DEPLOY - Prod" });
  });

  test("ready, merged, deploying, deployed", () => {
    expect(states({})).toEqual(["Checks:done", "Review:done", "Merge:waiting(ready to merge)", "Deploy:upcoming"]);
    expect(states({ autoMerge: true })[2]).toBe("Merge:running(auto-merge)");
    expect(progressTrack(merged({ deployProgress: { done: 6, total: 7, current: "DEPLOY - Prod" } }), NOW).slice(2).map((s) => [s.state, s.detail])).toEqual([
      ["done", undefined], ["running", "6/7 · DEPLOY - Prod"],
    ]);
    expect(progressTrack(merged({ deploy: "SUCCEEDED" }), NOW).every((s) => s.state === "done")).toBe(true);
  });

  test("what fails is red on its step", () => {
    expect(states({ checks: "FAIL", failingChecks: ["Build"] })[0]).toBe("Checks:failed(Build)");
    expect(states({ review: "CHANGES_REQUESTED" })[1]).toBe("Review:failed(changes requested)");
    expect(progressTrack(merged({ deploy: "FAILED" }), NOW).at(-1)).toEqual({ name: "Deploy", state: "failed" });
  });

  test("the PR itself (draft, conflicts, behind) is the icon in front of the line, not a stage; no deploy step where nothing deploys", () => {
    expect(progressTrack(aFacts({ draft: true, branch: "CONFLICT" }), NOW).map((s) => s.name)).toEqual(["Checks", "Review", "Merge", "Deploy"]);
    expect(progressTrack(merged({ deploy: "NO_RUNS", deployPossible: false }), NOW).map((s) => s.name)).toEqual(["Checks", "Review", "Merge"]);
  });
});

describe("trackText: the track in a message", () => {
  test("a mark per state, details where there are some", () => {
    const text = trackText(progressTrack(merged({ deployProgress: { done: 6, total: 7, current: "DEPLOY - Prod" } }), NOW));
    expect(text).toBe("Checks ✓ · Review ✓ · Merge ✓ · Deploy … 6/7 · DEPLOY - Prod");
    expect(trackText(progressTrack(aFacts({ review: "REVIEW_REQUIRED" }), NOW))).toBe("Checks ✓ · Review ⏸ waiting for code review · Merge · Deploy");
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
    expect(progressTrack(facts, NOW)[0]).toEqual({ name: "Checks", state: "running", detail: "2/5 · run approval for prod" });
  });

  test("once a run waits, what it waits for replaces the expectation", () => {
    const facts = aFacts({ checks: "PENDING", waitingChecks: ["Plan prod"], expectedChecksApproval: ["prod"] });
    expect(progressTrack(facts, NOW)[0]).toEqual({ name: "Checks", state: "waiting", detail: "run approval: Plan prod" });
  });
});
