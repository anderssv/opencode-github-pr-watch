import { describe, expect, test } from "bun:test";
import { deployPossible, startsOnMerge, workflowEnvironments } from "../core/merge-triggers";

const on = (trigger: string) => `name: W\non:${trigger}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n`;

describe("startsOnMerge: can a merge into the base branch start this workflow?", () => {
  test("a push to the base branch, in every way it can be written", () => {
    expect(startsOnMerge(on(" push"), "main")).toBe(true);
    expect(startsOnMerge(on(" [push, pull_request]"), "main")).toBe(true);
    expect(startsOnMerge(on("\n  push:\n"), "main")).toBe(true);
    expect(startsOnMerge(on("\n  push:\n    branches: [main]"), "main")).toBe(true);
    expect(startsOnMerge(on("\n  push:\n    branches:\n      - 'release/**'\n      - main"), "main")).toBe(true);
    expect(startsOnMerge(on("\n  push:\n    branches: ['ma*']"), "main")).toBe(true);
    expect(startsOnMerge(on("\n  push:\n    paths: ['src/**']"), "main")).toBe(true);
  });

  test("another workflow finishing can start it: a deploy chained after a build", () => {
    expect(startsOnMerge(on("\n  workflow_run:\n    workflows: [Build]\n    types: [completed]"), "main")).toBe(true);
  });

  test("not on a merge: other branches, tags only, ignored branches, or other events", () => {
    expect(startsOnMerge(on("\n  push:\n    branches: [develop]"), "main")).toBe(false);
    expect(startsOnMerge(on("\n  push:\n    tags: ['v*']"), "main")).toBe(false);
    expect(startsOnMerge(on("\n  push:\n    branches-ignore: [main]"), "main")).toBe(false);
    expect(startsOnMerge(on("\n  issues:\n    types: [opened]"), "main")).toBe(false);
    expect(startsOnMerge(on(" [pull_request, workflow_dispatch, schedule]"), "main")).toBe(false);
    expect(startsOnMerge(on("\n  release:\n    types: [published]"), "main")).toBe(false);
  });

  test("a file that can't be read gives no answer", () => {
    expect(startsOnMerge("on: [push\n", "main")).toBeUndefined();
    expect(startsOnMerge("name: no trigger\n", "main")).toBeUndefined();
  });
});

describe("deployPossible: can a deploy still come after the merge?", () => {
  test("no workflow starts on a merge: no deploy can come", () => {
    expect(deployPossible([])).toBe(false);
  });

  test("only workflows the model judged not to deploy: no deploy can come", () => {
    expect(deployPossible(["other", "other"])).toBe(false);
  });

  test("one that deploys, or one not judged yet: it may come", () => {
    expect(deployPossible(["other", "deploy"])).toBe(true);
    expect(deployPossible(["other", undefined])).toBeUndefined();
  });
});

describe("workflowEnvironments: the environments a workflow's jobs deploy to", () => {
  test("as a name or as an object, once each, in order", () => {
    const file = [
      "on: push",
      "jobs:",
      "  build: { runs-on: ubuntu-latest, steps: [] }",
      "  dev: { environment: dev, runs-on: x, steps: [] }",
      "  prod:",
      "    environment:",
      "      name: prod",
      "      url: https://example.com",
      "    steps: []",
      "  prod-again: { environment: prod, steps: [] }",
    ].join("\n");
    expect(workflowEnvironments(file)).toEqual(["dev", "prod"]);
  });

  test("expressions can't be known ahead, and a file that can't be read has none", () => {
    expect(workflowEnvironments("jobs:\n  d: { environment: '${{ inputs.env }}', steps: [] }\n")).toEqual([]);
    expect(workflowEnvironments("jobs: [")).toEqual([]);
  });
});
