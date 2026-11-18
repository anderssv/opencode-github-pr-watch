import { describe, expect, test } from "bun:test";
import { whoActs } from "../core/actor";
import { aFacts } from "./mothers";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const merged = (overrides = {}) => aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING", ...overrides });

describe("whoActs: who has to do something for the PR to move on", () => {
  test.each([
    ["checks running", aFacts({ checks: "PENDING" })],
    ["deploying", merged()],
    ["deploy starting", merged({ deploy: "NO_RUNS" })],
    ["auto-merge on a ready PR", aFacts({ autoMerge: true })],
    ["auto-merge updating a branch behind", aFacts({ branch: "BEHIND", autoMerge: true })],
  ])("nobody: %s", (_, facts) => {
    expect(whoActs(facts, NOW)).toBe("nobody");
  });

  test.each([
    ["checks failed", aFacts({ checks: "FAIL", failingChecks: ["Build"] })],
    ["changes requested", aFacts({ review: "CHANGES_REQUESTED" })],
    ["conflicts", aFacts({ branch: "CONFLICT" })],
    ["behind without auto-merge", aFacts({ branch: "BEHIND" })],
    ["deploy failed", merged({ deploy: "FAILED" })],
    ["deploy workflow unknown", merged({ deploy: "UNIDENTIFIED", mergedAt: NOW - 3_600_000 })],
  ])("the agent: %s", (_, facts) => {
    expect(whoActs(facts, NOW)).toBe("agent");
  });

  test.each([
    ["review", aFacts({ review: "REVIEW_REQUIRED" })],
    ["run approval on a check", aFacts({ checks: "PENDING", waitingChecks: ["Plan"] })],
    ["run approval on the deploy", merged({ deploy: "WAITING" })],
    ["ready for merge", aFacts()],
    ["draft", aFacts({ draft: true })],
  ])("a person: %s", (_, facts) => {
    expect(whoActs(facts, NOW)).toBe("person");
  });

  test.each([
    ["deployed", merged({ deploy: "SUCCEEDED" })],
    ["merged, no deploy", merged({ deploy: "NO_RUNS", mergedAt: NOW - 3_600_000 })],
    ["nothing to deploy", merged({ deploy: "NOTHING" })],
    ["closed", aFacts({ state: "CLOSED" })],
  ])("done: %s", (_, facts) => {
    expect(whoActs(facts, NOW)).toBe("done");
  });
});
