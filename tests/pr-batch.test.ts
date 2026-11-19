import { describe, expect, test } from "bun:test";
import { PrBatcher, toPrView } from "../core/pr-batch";
import type { Gh } from "../core/github";

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
  test("two reads in the window: one call, each gets its own PR", async () => {
    const { gh, queries } = fakeGraphql((alias) => ({ pullRequest: prNode(`title ${alias}`) }));
    const batcher = new PrBatcher(gh, 5);
    const [a, b] = await Promise.all([batcher.read("o/r", 1, "/w"), batcher.read("o/s", 2, "/w")]);
    expect(queries.length).toBe(1);
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
    expect(queries.length).toBe(2);
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
    expect(calls).toBe(3);
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

  test("no commits or no checks: no checks", () => {
    expect(toPrView(prNode("t", { commits: { nodes: [] } })).statusCheckRollup).toEqual([]);
    expect(toPrView(prNode("t", { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).statusCheckRollup).toEqual([]);
  });
});
