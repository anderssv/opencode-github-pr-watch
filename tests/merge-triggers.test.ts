import { describe, expect, test } from "bun:test";
import { deployPossible, startsOnMerge, startsOnPullRequest, workflowEnvironments } from "../core/merge-triggers";

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

describe("startsOnPullRequest: does a pull request into the base branch start this workflow?", () => {
  const on = (trigger: string) => `on:${trigger}\njobs: {}\n`;
  test("pull_request or pull_request_target, all branches or a filter matching the base", () => {
    expect(startsOnPullRequest(on(" pull_request"), "main")).toBe(true);
    expect(startsOnPullRequest(on(" [push, pull_request_target]"), "main")).toBe(true);
    expect(startsOnPullRequest(on("\n  pull_request:\n    branches: [main]"), "main")).toBe(true);
    expect(startsOnPullRequest(on("\n  pull_request:\n    branches: [develop]"), "main")).toBe(false);
    expect(startsOnPullRequest(on("\n  pull_request:\n    branches-ignore: [main]"), "main")).toBe(false);
    expect(startsOnPullRequest(on(" push"), "main")).toBe(false);
    expect(startsOnPullRequest("on: [pull\n", "main")).toBeUndefined();
  });
});

describe("startsOnMerge with the PR's changed files: path filters", () => {
  const terraform = "on:\n  push:\n    branches: [main]\n    paths:\n      - terraform/**\n      - .github/workflows/run-terraform.yml\n";
  const notDocs = "on:\n  push:\n    branches: [main]\n    paths-ignore:\n      - docs/**\n      - '**/*.md'\n";

  test("paths: starts only when a changed file matches", () => {
    expect(startsOnMerge(terraform, "main", ["docs/plan.md"])).toBe(false);
    expect(startsOnMerge(terraform, "main", ["docs/plan.md", "terraform/env/prod/main.tf"])).toBe(true);
    expect(startsOnMerge(terraform, "main", [".github/workflows/run-terraform.yml"])).toBe(true);
  });

  test("paths-ignore: starts when a changed file isn't ignored; ** matches no folder too", () => {
    expect(startsOnMerge(notDocs, "main", ["docs/plan.md", "README.md"])).toBe(false);
    expect(startsOnMerge(notDocs, "main", ["README.md", "src/app.kt"])).toBe(true);
  });

  test("! patterns exclude in order", () => {
    const file = "on:\n  push:\n    paths:\n      - 'src/**'\n      - '!src/**/*.md'\n";
    expect(startsOnMerge(file, "main", ["src/notes.md"])).toBe(false);
    expect(startsOnMerge(file, "main", ["src/app.kt"])).toBe(true);
  });

  test("without the changed files, path filters are left alone", () => {
    expect(startsOnMerge(terraform, "main")).toBe(true);
  });
});
