import { describe, expect, test } from "bun:test";
import { PrBatcher, toPrView } from "../core/pr-batch";
import type { Gh } from "../core/github";
import { pipelineChecks } from "../core/pr-facts";

const prNode = (title: string, extra: Record<string, unknown> = {}) => ({
  headRefOid: "abc", state: "OPEN", isDraft: false, baseRefName: "main", title, url: `https://github.com/o/r/pull/1`,
  reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", mergedAt: null, mergeCommit: null, autoMergeRequest: null,
  author: { login: "anna", __typename: "User" },
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
  comments: { nodes: [] },
  reviewThreads: { nodes: [] },
  ...extra,
});

/** Answers each alias in the query with the PR named by `answer`, recording the queries it was sent. */
const fakeGraphql = (answer: (alias: string) => unknown, errors?: unknown[]) => {
  const queries: string[] = [];
  const gh: Gh = async (args) => {
    const query = args.find((a) => a.startsWith("query="))!.slice("query=".length);
    queries.push(query);
    const aliases = [...query.matchAll(/(p\d+): repository/g)].map((m) => m[1]!);
    return JSON.stringify({ data: { viewer: { login: "me" }, ...Object.fromEntries(aliases.map((a) => [a, answer(a)])) }, ...(errors ? { errors } : {}) });
  };
  return { gh, queries };
};

describe("PrBatcher: PRs asked for close together are read in one GraphQL call", () => {
  test("two reads in the window: read together (the cheap part, then the details the first time), each gets its own PR", async () => {
    const { gh, queries } = fakeGraphql((alias) => ({ pullRequest: prNode(`title ${alias}`) }));
    const batcher = new PrBatcher(gh, 5);
    const [a, b] = await Promise.all([batcher.read("o/r", 1, "/w"), batcher.read("o/s", 2, "/w")]);
    expect(queries.length).toBe(2);
    expect([a.view.title, b.view.title]).toEqual(["title p0", "title p1"]);
    expect(queries[0]).toContain('p0: repository(owner: "o", name: "r") { pullRequest(number: 1)');
  });

  test("the same PR asked for twice is read once", async () => {
    const { gh, queries } = fakeGraphql(() => ({ pullRequest: prNode("t") }));
    const batcher = new PrBatcher(gh, 5);
    await Promise.all([batcher.read("o/r", 1, "/w"), batcher.read("o/r", 1, "/w")]);
    expect([...queries[0]!.matchAll(/repository\(/g)].length).toBe(1);
  });

  test("more than a batch holds: split into several calls", async () => {
    const { gh, queries } = fakeGraphql(() => ({ pullRequest: prNode("t") }));
    const batcher = new PrBatcher(gh, 5, 2);
    await Promise.all([1, 2, 3].map((n) => batcher.read("o/r", n, "/w")));
    expect(queries.filter((q) => q.includes("updatedAt")).length).toBe(2);
  });

  test("a PR that can't be read fails alone", async () => {
    const { gh } = fakeGraphql((alias) => (alias === "p1" ? { pullRequest: null } : { pullRequest: prNode("ok") }), [
      { path: ["p1", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 2." },
    ]);
    const batcher = new PrBatcher(gh, 5);
    const [a, b] = await Promise.allSettled([batcher.read("o/r", 1, "/w"), batcher.read("o/r", 2, "/w")]);
    expect(a.status).toBe("fulfilled");
    expect(b.status === "rejected" && String(b.reason)).toContain("Could not resolve to a PullRequest");
  });

  test("a call that fails for one PR: each asked for alone, so only that one fails", async () => {
    let calls = 0;
    const gh: Gh = async (args) => {
      calls++;
      const query = args.find((a) => a.startsWith("query="))!;
      if (query.includes("number: 2")) throw new Error("gh: Could not resolve to a PullRequest with the number of 2.");
      return JSON.stringify({ data: { viewer: { login: "me" }, p0: { pullRequest: prNode("one") } } });
    };
    const [a, b] = await Promise.allSettled([new PrBatcher(gh, 5).read("o/r", 1, "/w"), new PrBatcher(gh, 5).read("o/r", 2, "/w")]);
    expect([a.status, b.status]).toEqual(["fulfilled", "rejected"]);
    const batcher = new PrBatcher(gh, 5);
    calls = 0;
    const both = await Promise.allSettled([batcher.read("o/r", 1, "/w"), batcher.read("o/r", 2, "/w")]);
    expect(both.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    // The cheap read for both, then each alone; then the details of the one that exists.
    expect(calls).toBe(4);
  });

  test("a failed call fails every PR in it, with its error", async () => {
    const batcher = new PrBatcher(async () => { throw new Error("GitHub is rate limiting"); }, 5);
    const results = await Promise.allSettled([batcher.read("o/r", 1, "/w"), batcher.read("o/r", 2, "/w")]);
    expect(results.map((r) => r.status === "rejected" && String(r.reason))).toEqual(["Error: GitHub is rate limiting", "Error: GitHub is rate limiting"]);
  });

  test("a repo or number that isn't one is refused without a call", async () => {
    const { gh, queries } = fakeGraphql(() => ({ pullRequest: prNode("t") }));
    const batcher = new PrBatcher(gh, 5);
    await expect(batcher.read('o/r") { x }', 1, "/w")).rejects.toThrow("Not a repository");
    expect(queries).toEqual([]);
  });

  test("comments come with the PR", async () => {
    const thread = { isResolved: false, path: "a.ts", comments: { nodes: [{ id: "t1", url: "u", authorAssociation: "MEMBER", author: { login: "bob", __typename: "User" } }] } };
    const { gh } = fakeGraphql(() => ({ pullRequest: prNode("t", { reviewThreads: { nodes: [thread] } }) }));
    const read = await new PrBatcher(gh, 5).read("o/r", 1, "/w");
    expect(read.comments.unresolvedThreads).toBe(1);
    expect(read.comments.comments.map((c) => c.author)).toEqual(["bob"]);
  });
});

describe("toPrView: the GraphQL answer in gh pr view's shape", () => {
  test("bots, reviewers and the workflow of each check", () => {
    const view = toPrView(prNode("t", {
      author: { login: "dependabot", __typename: "Bot" },
      autoMergeRequest: { mergeMethod: "SQUASH" },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "anna" } }, { requestedReviewer: { __typename: "Team", name: "approvers" } }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "s", detailsUrl: "d", checkSuite: { workflowRun: { workflow: { name: "MAIN" } } } },
        { __typename: "StatusContext", context: "ci/legacy", state: "PENDING", createdAt: "c", targetUrl: "t" },
      ] } } } }] },
    }));
    expect(view.author).toEqual({ login: "dependabot", is_bot: true });
    expect(view.autoMergeRequest).toEqual({ mergeMethod: "SQUASH" });
    expect(view.reviewRequests).toEqual([{ login: "anna" }, { name: "approvers" }]);
    expect(view.statusCheckRollup).toEqual([
      { name: "Build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "s", detailsUrl: "d", workflowName: "MAIN" },
      { context: "ci/legacy", state: "PENDING", startedAt: "c" },
    ]);
  });

  test("a check from code scanning (no workflow) gets an empty workflow name, as gh gives it, so it's left out of the pipeline", () => {
    const view = toPrView(prNode("t", { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", name: "Trivy", status: "COMPLETED", conclusion: "NEUTRAL", startedAt: "s", detailsUrl: "d", checkSuite: { workflowRun: null } },
    ] } } } }] } }));
    expect(view.statusCheckRollup[0]!.workflowName).toBe("");
    expect(pipelineChecks(view.statusCheckRollup)).toEqual([]);
  });

  test("no commits or no checks: no checks", () => {
    expect(toPrView(prNode("t", { commits: { nodes: [] } })).statusCheckRollup).toEqual([]);
    expect(toPrView(prNode("t", { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).statusCheckRollup).toEqual([]);
  });
});

describe("PrBatcher: the check list and the comments only when they may have changed", () => {
  const rollup = (running: number) => ({ state: "PENDING", contexts: { totalCount: 3, checkRunCountsByState: [{ state: "IN_PROGRESS", count: running }], statusContextCountsByState: [] } });
  const cheapNode = (updatedAt: string, running: number) => prNode("t", { updatedAt, commits: { nodes: [{ commit: { statusCheckRollup: rollup(running) } }] } });
  const reader = (answer: () => unknown) => {
    let now = 0;
    const { gh, queries } = fakeGraphql(() => answer());
    return { batcher: new PrBatcher(gh, 5, 50, () => now), queries, later: (ms: number) => (now += ms) };
  };

  test("nothing changed: only the cheap read", async () => {
    let node = cheapNode("t1", 2);
    const { batcher, queries, later } = reader(() => ({ pullRequest: node }));
    await batcher.read("o/r", 1, "/w");
    later(30_000);
    node = cheapNode("t1", 2);
    await batcher.read("o/r", 1, "/w");
    expect(queries.length).toBe(3);
    expect(queries[2]).toContain("updatedAt");
  });

  test("a check moved: the check list, not the comments", async () => {
    let node = cheapNode("t1", 2);
    const { batcher, queries, later } = reader(() => ({ pullRequest: node }));
    await batcher.read("o/r", 1, "/w");
    later(30_000);
    node = cheapNode("t1", 1);
    await batcher.read("o/r", 1, "/w");
    expect(queries[3]).toContain("contexts(first: 100)");
    expect(queries[3]).not.toContain("reviewThreads");
  });

  test("the PR was updated (a comment, a review): the comments, not the check list", async () => {
    let node = cheapNode("t1", 2);
    const { batcher, queries, later } = reader(() => ({ pullRequest: node }));
    await batcher.read("o/r", 1, "/w");
    later(30_000);
    node = cheapNode("t2", 2);
    await batcher.read("o/r", 1, "/w");
    expect(queries[3]).toContain("reviewThreads");
    expect(queries[3]).not.toContain("contexts(first: 100)");
  });

  test("the kept checks and comments are given along with the fresh cheap part", async () => {
    const thread = { isResolved: false, path: "a.ts", comments: { nodes: [{ id: "t1", url: "u", authorAssociation: "MEMBER", author: { login: "bob", __typename: "User" } }] } };
    const check = { __typename: "CheckRun", name: "Build", status: "IN_PROGRESS", conclusion: null, startedAt: "s", detailsUrl: "d", checkSuite: { workflowRun: { workflow: { name: "CI" } } } };
    let node: unknown = prNode("t", { updatedAt: "t1", reviewThreads: { nodes: [thread] }, commits: { nodes: [{ commit: { statusCheckRollup: { ...rollup(1), contexts: { ...rollup(1).contexts, nodes: [check] } } } }] } });
    const { batcher, later } = reader(() => ({ pullRequest: node }));
    await batcher.read("o/r", 1, "/w");
    later(30_000);
    node = { ...cheapNode("t1", 1), reviewDecision: "APPROVED" };
    const read = await batcher.read("o/r", 1, "/w");
    expect(read.view.reviewDecision).toBe("APPROVED");
    expect(read.view.statusCheckRollup.map((c) => c.name)).toEqual(["Build"]);
    expect(read.comments.unresolvedThreads).toBe(1);
  });

  test("read again after a while anyway, for what the markers miss (a thread resolved)", async () => {
    const node = cheapNode("t1", 2);
    const { batcher, queries, later } = reader(() => ({ pullRequest: node }));
    await batcher.read("o/r", 1, "/w");
    later(11 * 60_000);
    await batcher.read("o/r", 1, "/w");
    expect(queries[3]).toContain("reviewThreads");
    expect(queries[3]).toContain("contexts(first: 100)");
  });
});

describe("PrBatcher: who closed the PR", () => {
  test("the gh user (the viewer) or someone else", async () => {
    const closed = (login: string) => fakeGraphql(() => ({ pullRequest: prNode("t", { state: "CLOSED", timelineItems: { nodes: [{ actor: { login } }] } }) }));
    expect((await new PrBatcher(closed("me").gh, 5).read("o/r", 1, "/w")).view.closedByViewer).toBe(true);
    expect((await new PrBatcher(closed("anna").gh, 5).read("o/r", 1, "/w")).view.closedByViewer).toBeUndefined();
  });
});
