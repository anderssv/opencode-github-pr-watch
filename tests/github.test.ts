import { describe, expect, test } from "bun:test";
import { blockedChecks, blockingRun, commentCounts, laterDeploy, mergeWorkflows, prForRun, parsePrReference, prSnapshot, requiredChecks, runLine, type Gh } from "../core/github";

describe("parsePrReference", () => {
  test("reads a plain PR number", () => {
    expect(parsePrReference("1864")).toEqual({ pr: 1864 });
  });

  test("reads a #-prefixed PR number", () => {
    expect(parsePrReference("#1864")).toEqual({ pr: 1864 });
  });

  test("reads owner/repo#number", () => {
    expect(parsePrReference("acme/api#42")).toEqual({ repo: "acme/api", pr: 42 });
  });

  test("reads a GitHub PR URL", () => {
    expect(parsePrReference("https://github.com/acme/web/pull/1481")).toEqual({
      repo: "acme/web",
      pr: 1481,
    });
  });

  test("rejects anything else", () => {
    expect(parsePrReference("the latest one")).toBeUndefined();
  });
});

describe("runLine", () => {
  test("shows the workflow, trigger, start time, status and link", () => {
    const line = runLine({
      databaseId: 1,
      workflowName: "MAIN - Deployment pipeline",
      event: "schedule",
      createdAt: "2026-10-09T07:43:58Z",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/o/r/actions/runs/1",
    });

    expect(line).toBe(
      "  - MAIN - Deployment pipeline [schedule] started 2026-10-09T07:43:58Z: completed failure https://github.com/o/r/actions/runs/1",
    );
  });
});

describe("requiredChecks", () => {
  const fakeGh = (responses: Record<string, string | Error>): Gh => async (args) => {
    const path = args[1]!;
    const response = responses[path];
    if (response === undefined) throw new Error(`unexpected gh api ${path}`);
    if (response instanceof Error) throw response;
    return response;
  };

  test("combines branch protection and rulesets, without duplicates", async () => {
    const gh = fakeGh({
      "repos/acme/platform/branches/main": JSON.stringify({
        protection: { required_status_checks: { contexts: ["Build status - core", "Build status - api-specs"] } },
      }),
      "repos/acme/platform/rules/branches/main": JSON.stringify([
        { type: "pull_request", parameters: {} },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Build status - core" }, { context: "Lint" }] } },
      ]),
    });

    expect(await requiredChecks(gh, "acme/platform", "main", "/repo")).toEqual(["Build status - api-specs", "Build status - core", "Lint"]);
  });

  test("an unprotected branch requires nothing", async () => {
    const gh = fakeGh({
      "repos/o/r/branches/main": JSON.stringify({ protected: false }),
      "repos/o/r/rules/branches/main": "[]",
    });

    expect(await requiredChecks(gh, "o/r", "main", "/repo")).toEqual([]);
  });

  test("one source failing still uses the other", async () => {
    const gh = fakeGh({
      "repos/o/r/branches/main": new Error("HTTP 403"),
      "repos/o/r/rules/branches/main": JSON.stringify([
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Build" }] } },
      ]),
    });

    expect(await requiredChecks(gh, "o/r", "main", "/repo")).toEqual(["Build"]);
  });
});

describe("prSnapshot: a monorepo merge", () => {
  // A fake gh answering the calls prSnapshot makes: the PR, the runs on the merge commit and each run's jobs.
  const fakeGh = (): Gh => async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        state: "MERGED", isDraft: false, baseRefName: "main", title: "Bump x", url: "https://github.com/o/r/pull/1",
        reviewDecision: "APPROVED", mergeStateStatus: "UNKNOWN", mergedAt: "2026-11-16T13:51:00Z", mergeCommit: { oid: "abc" },
        headRefOid: "def", statusCheckRollup: [],
      });
    }
    if (args[0] === "run" && args[1] === "list") {
      return JSON.stringify([
        { databaseId: 1, workflowName: "Platform - Deploy pipeline", status: "completed", conclusion: "success", event: "push", createdAt: "2026-11-16T13:51:03Z", url: "u1" },
        { databaseId: 2, workflowName: "Web - Deploy pipeline", status: "completed", conclusion: "success", event: "push", createdAt: "2026-11-16T13:51:03Z", url: "u2" },
      ]);
    }
    if (args[0] === "run" && args[1] === "view") {
      return JSON.stringify({ jobs: [{ name: "Detect changes", status: "completed", conclusion: "success" }, { name: "DEPLOY - Prod", status: "completed", conclusion: "skipped" }] });
    }
    return "[]";
  };

  test("skipped component pipelines are left out of the state the model judges", async () => {
    const snapshot = await prSnapshot(fakeGh(), "o/r", 1, "/tmp", Date.parse("2026-11-16T14:00:00Z"));
    expect(snapshot.facts?.deploy).toBe("NOTHING");
    expect(snapshot.text).not.toContain("skipped (component unchanged)");
    expect(snapshot.text).not.toContain("Web");
  });
});

describe("prSnapshot: a merge in a repo where nothing a merge starts deploys", () => {
  const fakeGh = (workflowFile: string): Gh => async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        state: "MERGED", isDraft: false, baseRefName: "main", title: "Docs", url: "https://github.com/o/r/pull/2",
        reviewDecision: "APPROVED", mergeStateStatus: "UNKNOWN", mergedAt: "2026-11-16T13:51:00Z", mergeCommit: { oid: "abc" },
        headRefOid: "def", statusCheckRollup: [],
      });
    }
    if (args[0] === "run" && args[1] === "list") {
      return JSON.stringify([{ databaseId: 1, workflowName: "Push on main", status: "in_progress", conclusion: "", event: "dynamic", createdAt: "2026-11-16T13:51:03Z", url: "u1" }]);
    }
    if (args[0] === "api" && args[1] === "repos/o/r/actions/workflows") {
      return JSON.stringify({ workflows: [{ id: 5, path: ".github/workflows/w.yml", state: "active" }, { id: 6, path: "dynamic/github-code-scanning/codeql", state: "active" }] });
    }
    if (args[0] === "api" && args[1] === "repos/o/r/contents/.github/workflows/w.yml?ref=main") return workflowFile;
    return "[]";
  };
  const justAfter = Date.parse("2026-11-16T13:52:00Z");

  test("only workflows that don't start on a merge: no deploy can come, and the model isn't asked", async () => {
    const asked: number[] = [];
    const snapshot = await prSnapshot(fakeGh("on:\n  issues: {}\njobs: {}\n"), "o/r", 2, "/tmp", justAfter, async (id) => (asked.push(id), "deploy"));
    expect(snapshot.facts?.deployPossible).toBe(false);
    expect(asked).toEqual([]);
  });

  test("a workflow that starts on a merge counts by its role", async () => {
    const push = "on:\n  push:\n    branches: [main]\njobs: {}\n";
    expect((await prSnapshot(fakeGh(push), "o/r", 2, "/tmp", justAfter, async () => "other")).facts?.deployPossible).toBe(false);
    expect((await prSnapshot(fakeGh(push), "o/r", 2, "/tmp", justAfter, async () => "deploy")).facts?.deployPossible).toBe(true);
    expect((await prSnapshot(fakeGh(push), "o/r", 2, "/tmp", justAfter, async () => undefined)).facts?.deployPossible).toBeUndefined();
  });

  test("without a model, code still decides when nothing starts on a merge; otherwise it waits as before", async () => {
    expect((await prSnapshot(fakeGh("on:\n  issues: {}\njobs: {}\n"), "o/r", 2, "/tmp", justAfter)).facts?.deployPossible).toBe(false);
    expect((await prSnapshot(fakeGh("on: push\njobs: {}\n"), "o/r", 2, "/tmp", justAfter)).facts?.deployPossible).toBeUndefined();
  });
});

describe("laterDeploy: a later run that deployed this merge (plan 1)", () => {
  const failed = { workflowDatabaseId: 7, createdAt: "2026-10-12T10:00:00Z" };
  const fakeGh = (compare: Record<string, string>, deployJob = "success"): Gh => async (args) => {
    if (args[0] === "run" && args[1] === "list") {
      return JSON.stringify([
        { databaseId: 3, headSha: "newer", createdAt: "2026-10-12T11:00:00Z", url: "https://github.com/o/r/actions/runs/3", displayTitle: "Bump ktor (#2328)" },
        { databaseId: 1, headSha: "older", createdAt: "2026-10-12T09:00:00Z", url: "u1", displayTitle: "Older" },
      ]);
    }
    if (args[0] === "run" && args[1] === "view") return JSON.stringify({ jobs: [{ name: "DEPLOY - Dev", conclusion: deployJob }] });
    if (args[0] === "api") return compare[args[1]!.split("/compare/")[1]!] ?? "diverged";
    return "";
  };

  test("a successful later run whose commit contains the merge", async () => {
    const found = await laterDeploy(fakeGh({ "abc...newer": "ahead" }), "o/r", "abc", "main", [failed], "/tmp");
    expect(found).toEqual({ title: "Bump ktor (#2328)", url: "https://github.com/o/r/actions/runs/3" });
  });

  test("not when it doesn't contain the merge, or deployed nothing", async () => {
    expect(await laterDeploy(fakeGh({ "abc...newer": "behind" }), "o/r", "abc", "main", [failed], "/tmp")).toBeUndefined();
    expect(await laterDeploy(fakeGh({ "abc...newer": "ahead" }, "skipped"), "o/r", "abc", "main", [failed], "/tmp")).toBeUndefined();
  });
});

describe("blockingRun: an older run of the workflow waiting for approval (plan 2)", () => {
  const fakeGh: Gh = async (args) =>
    args.includes("waiting")
      ? JSON.stringify([
          { databaseId: 9, createdAt: "2026-10-04T08:00:00Z", url: "https://github.com/o/r/actions/runs/9", displayTitle: "Apply bass Team (#751)" },
          { databaseId: 20, createdAt: "2026-10-13T08:00:00Z", url: "u20", displayTitle: "Newer" },
        ])
      : "[]";

  test("the oldest one older than the queued run", async () => {
    expect(await blockingRun(fakeGh, "o/r", { databaseId: 15, workflowDatabaseId: 7 }, "/tmp")).toEqual({ title: "Apply bass Team (#751)", url: "https://github.com/o/r/actions/runs/9", since: Date.parse("2026-10-04T08:00:00Z") });
    expect(await blockingRun(fakeGh, "o/r", { databaseId: 5, workflowDatabaseId: 7 }, "/tmp")).toBeUndefined();
  });
});

describe("prForRun: only the PR's own runs belong to it (plan 8)", () => {
  const fakeGh = (event: string): Gh => async (args) =>
    args[0] === "run" ? JSON.stringify({ headSha: "abc", event }) : "1877";

  test("a pull_request run and a push run on the merge commit", async () => {
    expect(await prForRun(fakeGh("pull_request"), "o/r", "5", "/tmp")).toBe(1877);
    expect(await prForRun(fakeGh("push"), "o/r", "5", "/tmp")).toBe(1877);
  });

  test("not a manual dispatch or a schedule on the same commit", async () => {
    expect(await prForRun(fakeGh("workflow_dispatch"), "o/r", "5", "/tmp")).toBeUndefined();
    expect(await prForRun(fakeGh("schedule"), "o/r", "5", "/tmp")).toBeUndefined();
  });
});

describe("requiredChecks: a failed read is not 'no required checks'", () => {
  test("a server error or timeout throws, so the PR isn't judged ready on missing facts", async () => {
    const gh: Gh = async () => {
      throw new Error("HTTP 502: Bad Gateway");
    };
    await expect(requiredChecks(gh, "o/r", "main", "/repo")).rejects.toThrow("502");
  });
});

describe("prSnapshot: a failed read decides nothing", () => {
  test("runs that can't be read give no facts, instead of 'no deploy started'", async () => {
    const gh: Gh = async (args) => {
      if (args[0] === "pr") {
        return JSON.stringify({ state: "MERGED", isDraft: false, baseRefName: "main", title: "x", url: "u", reviewDecision: "APPROVED", mergeStateStatus: "UNKNOWN", mergedAt: "2026-11-16T10:00:00Z", mergeCommit: { oid: "abc" }, statusCheckRollup: [] });
      }
      throw new Error("HTTP 502: Bad Gateway");
    };
    const snapshot = await prSnapshot(gh, "o/r", 1, "/tmp", Date.parse("2026-11-16T11:00:00Z"));
    expect(snapshot.facts).toBeUndefined();
    expect(snapshot.text).toContain("Could not read the workflow runs: HTTP 502");
  });
});

describe("blockedChecks: the PR's check runs queued behind runs waiting for run approval (infra#752)", () => {
  const fakeGh: Gh = async (args) => {
    const joined = args.join(" ");
    if (joined.includes("--commit head")) {
      return JSON.stringify([
        { databaseId: 57, workflowName: "BICEP - Deploy", workflowDatabaseId: 1, status: "pending", event: "pull_request" },
        { databaseId: 55, workflowName: "TERRAFORM - Apply", workflowDatabaseId: 2, status: "pending", event: "pull_request" },
        { databaseId: 45, workflowName: "CODE - Linting", workflowDatabaseId: 3, status: "completed", event: "pull_request" },
      ]);
    }
    if (args[0] === "run" && args[1] === "view") return JSON.stringify({ jobs: [] });
    if (joined.includes("--status waiting") && joined.includes("--workflow 1")) {
      return JSON.stringify([{ databaseId: 13, createdAt: "2026-11-16T19:43:13Z", url: "u13", displayTitle: "chore(deps): bump workflows" }]);
    }
    if (joined.includes("--status waiting")) return "[]";
    return "[]";
  };

  test("each queued run with no jobs, and the older run waiting ahead of it", async () => {
    expect(await blockedChecks(fakeGh, "o/r", "head", "/tmp")).toEqual([
      { workflow: "BICEP - Deploy", title: "chore(deps): bump workflows", url: "u13", since: Date.parse("2026-11-16T19:43:13Z") },
    ]);
  });
});

describe("mergeWorkflows: the workflows a merge into the base branch can start", () => {
  const gh = (files: Record<string, string | Error>): Gh => async (args) => {
    const path = args[1]!;
    if (path === "repos/acme/docs/actions/workflows") {
      return JSON.stringify({
        workflows: [
          { id: 1, path: ".github/workflows/add-to-project.yml", state: "active" },
          { id: 2, path: ".github/workflows/deploy.yml", state: "active" },
          { id: 3, path: ".github/workflows/old.yml", state: "disabled_manually" },
          { id: 4, path: "dynamic/github-code-scanning/codeql", state: "active" },
        ],
      });
    }
    const file = files[path];
    if (file === undefined) throw new Error(`unexpected gh api ${path}`);
    if (file instanceof Error) throw file;
    return file;
  };
  const issues = "on:\n  issues:\n    types: [opened]\njobs: {}\n";
  const push = "on:\n  push:\n    branches: [main]\njobs: {}\n";

  test("active workflow files that start on a push to the base branch; GitHub's own setups and disabled ones don't count", async () => {
    const found = await mergeWorkflows(
      gh({
        "repos/acme/docs/contents/.github/workflows/add-to-project.yml?ref=main": issues,
        "repos/acme/docs/contents/.github/workflows/deploy.yml?ref=main": push,
      }),
      "acme/docs", "main", "/w",
    );
    expect(found).toEqual([2]);
  });

  test("none when nothing starts on a merge", async () => {
    const found = await mergeWorkflows(
      gh({ "repos/acme/docs/contents/.github/workflows/add-to-project.yml?ref=main": issues, "repos/acme/docs/contents/.github/workflows/deploy.yml?ref=main": issues }),
      "acme/docs", "main", "/w",
    );
    expect(found).toEqual([]);
  });

  test("no answer when a file can't be read or understood, so the watch keeps waiting as before", async () => {
    expect(
      await mergeWorkflows(gh({ "repos/acme/docs/contents/.github/workflows/add-to-project.yml?ref=main": issues, "repos/acme/docs/contents/.github/workflows/deploy.yml?ref=main": new Error("404") }), "acme/docs", "main", "/w"),
    ).toBeUndefined();
    expect(
      await mergeWorkflows(gh({ "repos/acme/docs/contents/.github/workflows/add-to-project.yml?ref=main": issues, "repos/acme/docs/contents/.github/workflows/deploy.yml?ref=main": "on: [push\n" }), "acme/docs", "main", "/w"),
    ).toBeUndefined();
  });
});

describe("commentCounts", () => {
  const node = (comments: number) => ({ pullRequest: { comments: { totalCount: comments }, reviewThreads: { totalCount: 0, nodes: [] } } });
  // GitHub fails the whole query when one PR in it can't be found.
  const fakeGh = (missing: number): Gh => async (args) => {
    const query = args.find((a) => a.startsWith("query="))!;
    if (query.includes(`pullRequest(number: ${missing})`)) throw new Error(`gh: Could not resolve to a PullRequest with the number of ${missing}.`);
    const numbers = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
    return JSON.stringify({ data: Object.fromEntries(numbers.map((n, i) => [`p${i}`, node(n)])) });
  };

  test("one PR that can't be read doesn't cost the others their counts", async () => {
    const counts = await commentCounts(fakeGh(2), [{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }, { repo: "o/r", number: 3 }], "/tmp");
    expect(counts).toEqual({ "o/r#1": { total: 1, unresolved: 0, threads: 0 }, "o/r#3": { total: 3, unresolved: 0, threads: 0 } });
  });
});
