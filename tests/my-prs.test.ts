import { describe, expect, test } from "bun:test";
import { allPrs, byRepo, matchesSearch, myPrFrom, prList, runWatches, watchedIn, withWatchedPrs, organisationsOf, prSessionPrompt, type MyPr } from "../core/my-prs";

const pr = (repo: string, number: number, extra: Partial<MyPr> = {}): MyPr => ({
  repo, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, draft: false, createdAt: "2026-11-10T10:00:00Z", ...extra,
});

describe("my PRs (side panel)", () => {
  test("from gh search output", () => {
    const raw = { repository: { nameWithOwner: "o/r" }, number: 7, title: "Docs", url: "u", isDraft: true, createdAt: "2026-11-10T10:00:00Z", closedAt: "2026-11-12T10:00:00Z" };
    expect(myPrFrom(raw)).toEqual({ repo: "o/r", number: 7, title: "Docs", url: "u", draft: true, createdAt: "2026-11-10T10:00:00Z", closedAt: "2026-11-12T10:00:00Z" });
  });

  test("gh's zero date for an open PR is no date", () => {
    const raw = { repository: { nameWithOwner: "o/r" }, number: 7, title: "x", url: "u", isDraft: false, createdAt: "2026-11-10T10:00:00Z", closedAt: "0001-01-01T00:00:00Z" };
    expect(myPrFrom(raw).closedAt).toBeUndefined();
  });

  test("organisations for the dropdown, sorted and unique", () => {
    expect(organisationsOf([pr("b/x", 1), pr("a/y", 2), pr("b/z", 3)])).toEqual(["a", "b"]);
  });

  test("grouped by repo in name order, newest PR first, optionally one organisation only", () => {
    const prs = [pr("b/x", 1), pr("a/y", 2), pr("b/x", 5), pr("b/a", 3)];
    expect(byRepo(prs).map((g) => [g.repo, g.prs.map((p) => p.number)])).toEqual([["a/y", [2]], ["b/a", [3]], ["b/x", [5, 1]]]);
    expect(byRepo(prs, "a").map((g) => g.repo)).toEqual(["a/y"]);
  });
});

describe("sorting (by name, newest PR, oldest PR)", () => {
  const prs = [
    pr("o/b", 1, { createdAt: "2026-11-01T10:00:00Z" }),
    pr("o/b", 2, { createdAt: "2026-11-15T10:00:00Z" }),
    pr("o/a", 3, { createdAt: "2026-11-10T10:00:00Z" }),
    pr("o/c", 4, { createdAt: "2026-11-05T10:00:00Z" }),
  ];
  const order = (sort: "name" | "newest" | "oldest") => byRepo(prs, undefined, sort).map((g) => [g.repo, g.prs.map((p) => p.number)]);

  test("by name: repos A–Z, newest PR first", () => {
    expect(order("name")).toEqual([["o/a", [3]], ["o/b", [2, 1]], ["o/c", [4]]]);
  });

  test("by newest PR: the repo with the most recent PR first, newest first in each", () => {
    expect(order("newest")).toEqual([["o/b", [2, 1]], ["o/a", [3]], ["o/c", [4]]]);
  });

  test("by oldest PR: the repo with the oldest PR first, oldest first in each", () => {
    expect(order("oldest")).toEqual([["o/b", [1, 2]], ["o/c", [4]], ["o/a", [3]]]);
  });

  test("merged PRs sort by when they merged", () => {
    const merged = [pr("o/a", 1, { createdAt: "2026-11-01T10:00:00Z", closedAt: "2026-11-16T10:00:00Z" }), pr("o/b", 2, { createdAt: "2026-11-10T10:00:00Z", closedAt: "2026-11-11T10:00:00Z" })];
    expect(byRepo(merged, undefined, "newest").map((g) => g.repo)).toEqual(["o/a", "o/b"]);
  });
});

describe("show drafts", () => {
  test("on by default; off leaves drafts out, and repos with only drafts", () => {
    const prs = [pr("o/a", 1, { draft: true }), pr("o/b", 2), pr("o/b", 3, { draft: true })];
    expect(byRepo(prs).flatMap((g) => g.prs.map((p) => p.number))).toEqual([1, 3, 2]);
    expect(byRepo(prs, undefined, "name", false).map((g) => [g.repo, g.prs.map((p) => p.number)])).toEqual([["o/b", [2]]]);
  });
});

describe("a session about a PR", () => {
  test("starts with the PR, its repo and link, and asks for a summary", () => {
    expect(prSessionPrompt(pr("o/r", 1877, { title: "Deploy by digest" }))).toBe("PR #1877 on o/r: Deploy by digest (https://github.com/o/r/pull/1877). Summarize it.");
  });
});

describe("text search", () => {
  const vault = pr("acme/infra", 803, { title: "Add delete locks to the storage buckets" });
  test("every word must match the title, repo or number, ignoring case", () => {
    expect(matchesSearch(vault, "bucket infra")).toBe(true);
    expect(matchesSearch(vault, "BUCKETS")).toBe(true);
    expect(matchesSearch(vault, "#803")).toBe(true);
    expect(matchesSearch(vault, "803")).toBe(true);
    expect(matchesSearch(vault, "bucket billing")).toBe(false);
  });

  test("an empty search matches everything", () => {
    expect(matchesSearch(vault, "  ")).toBe(true);
  });
});

describe("copying a group", () => {
  test("a - list of title and link, in the order given", () => {
    const prs = [pr("o/r", 2, { title: "Second" }), pr("o/r", 1, { title: "First" })];
    expect(prList(prs)).toBe("- Second: https://github.com/o/r/pull/2\n- First: https://github.com/o/r/pull/1");
  });
});

describe("one list: my PRs and the watches", () => {
  const mine = [pr("o/r", 1, { title: "Mine" })];
  const rows = [
    { id: "o/r#1", label: "o/r#1 Mine", url: "https://github.com/o/r/pull/1" },
    { id: "o/dep#7", label: "o/dep#7 Bump x from 1 to 2", url: "https://github.com/o/dep/pull/7" },
    { id: "o/r run 9", label: "o/r run 9 MAIN on main", url: "https://github.com/o/r/actions/runs/9" },
  ];

  test("watched PRs I didn't open join the list", () => {
    expect(withWatchedPrs(mine, rows).map((p) => [p.repo, p.number, p.title])).toEqual([["o/r", 1, "Mine"], ["o/dep", 7, "Bump x from 1 to 2"]]);
  });

  test("a watched PR I didn't open keeps its comment count", () => {
    const counted = [{ ...rows[1]!, comments: { total: 3, unresolved: 1, threads: 1 } }];
    expect(withWatchedPrs(mine, counted)[1]!.comments).toEqual({ total: 3, unresolved: 1, threads: 1 });
  });

  test("watches of runs without a PR are listed apart", () => {
    expect(runWatches(rows).map((r) => r.id)).toEqual(["o/r run 9"]);
  });
});

describe("no grouping: one list", () => {
  const prs = [
    pr("o/b", 1, { createdAt: "2026-11-01T10:00:00Z" }),
    pr("o/a", 2, { createdAt: "2026-11-05T10:00:00Z" }),
    pr("o/b", 3, { createdAt: "2026-11-10T10:00:00Z", draft: true }),
    pr("x/c", 4, { createdAt: "2026-11-03T10:00:00Z" }),
  ];
  const numbers = (sort: "name" | "newest" | "oldest", org?: string, drafts = true) => allPrs(prs, org, sort, drafts).map((p) => p.number);

  test("by name: by repo, newest first within it; by newest or oldest: by date", () => {
    expect(numbers("name")).toEqual([2, 3, 1, 4]);
    expect(numbers("newest")).toEqual([3, 2, 4, 1]);
    expect(numbers("oldest")).toEqual([1, 4, 2, 3]);
  });

  test("the organisation and drafts filters apply", () => {
    expect(numbers("name", "o", false)).toEqual([2, 1]);
  });
});

describe("current session only", () => {
  test("keeps the PRs this session watches", () => {
    const prs = [pr("o/r", 1), pr("o/r", 2), pr("o/r", 3)];
    const rows = [{ id: "o/r#1", sessionID: "s1" }, { id: "o/r#2", sessionID: "s2" }];
    expect(watchedIn(prs, rows, "s1").map((p) => p.number)).toEqual([1]);
  });
});
