import { describe, expect, test } from "bun:test";
import { commentBadge, commentCountsFrom, commentsQuery } from "../core/comments";

const pr = (comments: number, threads: { resolved: boolean; comments: number }[], totalThreads = threads.length) => ({
  pullRequest: {
    comments: { totalCount: comments },
    reviewThreads: { totalCount: totalThreads, nodes: threads.map((t) => ({ isResolved: t.resolved, comments: { totalCount: t.comments } })) },
  },
});

describe("commentsQuery", () => {
  test("asks for every PR at once, each under its own alias", () => {
    const query = commentsQuery([{ repo: "o/r", number: 7 }, { repo: "o/other", number: 12 }]);
    expect(query).toContain('p0: repository(owner: "o", name: "r") { pullRequest(number: 7)');
    expect(query).toContain('p1: repository(owner: "o", name: "other") { pullRequest(number: 12)');
    expect(query).toContain("reviewThreads(first: 100)");
  });

  test("doesn't ask for reviews: they aren't comments", () => {
    expect(commentsQuery([{ repo: "o/r", number: 7 }])).not.toContain("reviews(");
  });
});

describe("commentCountsFrom", () => {
  test("total is the PR's comments plus every review thread's; unresolved counts the comments in open threads", () => {
    const counts = commentCountsFrom({ p0: pr(2, [{ resolved: true, comments: 3 }, { resolved: false, comments: 1 }, { resolved: false, comments: 2 }]) }, [{ repo: "o/r", number: 7 }]);
    expect(counts).toEqual({ "o/r#7": { total: 8, unresolved: 3, threads: 3 } });
  });

  test("only ordinary comments: nothing that can be resolved", () => {
    expect(commentCountsFrom({ p0: pr(2, []) }, [{ repo: "o/r", number: 7 }])["o/r#7"]).toEqual({ total: 2, unresolved: 0, threads: 0 });
  });

  test("more threads than one page: marked as more", () => {
    const counts = commentCountsFrom({ p0: pr(0, [{ resolved: false, comments: 1 }], 150) }, [{ repo: "o/r", number: 7 }]);
    expect(counts["o/r#7"]).toEqual({ total: 1, unresolved: 1, threads: 1, more: true });
  });

  test("a PR GitHub didn't return is left out", () => {
    expect(commentCountsFrom({ p0: null }, [{ repo: "o/r", number: 7 }])).toEqual({});
  });
});

describe("commentBadge", () => {
  test("nothing to show without comments", () => {
    expect(commentBadge(undefined)).toBeUndefined();
    expect(commentBadge({ total: 0, unresolved: 0, threads: 0 })).toBeUndefined();
  });

  test("red when a comment is unresolved", () => {
    expect(commentBadge({ total: 5, unresolved: 2, threads: 2 })).toEqual({ text: "5", tone: "unresolved", tip: "5 comments, 2 unresolved" });
  });

  test("green when every comment that can be resolved is", () => {
    expect(commentBadge({ total: 5, unresolved: 0, threads: 2 })).toEqual({ text: "5", tone: "resolved", tip: "5 comments, all resolved" });
  });

  test("neutral when nothing can be resolved", () => {
    expect(commentBadge({ total: 1, unresolved: 0, threads: 0 })).toEqual({ text: "1", tone: "neutral", tip: "1 comment" });
  });

  test("more than one page: shown as at least", () => {
    expect(commentBadge({ total: 130, unresolved: 40, threads: 100, more: true })).toEqual({ text: "130+", tone: "unresolved", tip: "130+ comments, 40+ unresolved" });
  });
});
