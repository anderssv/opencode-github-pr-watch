import { describe, expect, test } from "bun:test";
import { commentEvents, parseComments } from "../core/comments";

const node = (id: string, login: string, extra: Record<string, unknown> = {}) => ({
  id, url: `https://github.com/o/r/pull/7#c-${id}`, authorAssociation: "MEMBER", author: { login, __typename: "User" }, ...extra,
});
const answer = (comments: unknown[], threads: unknown[]) => ({
  data: { viewer: { login: "me" }, repository: { pullRequest: { comments: { nodes: comments }, reviewThreads: { nodes: threads } } } },
});

describe("parseComments: who said something on the PR, never what", () => {
  test("conversation and review comments; unresolved threads counted", () => {
    const read = parseComments(answer(
      [node("c1", "anna")],
      [
        { isResolved: false, path: "src/a.ts", comments: { nodes: [node("t1", "bob")] } },
        { isResolved: true, path: "src/b.ts", comments: { nodes: [node("t2", "anna")] } },
      ],
    ));
    expect(read.unresolvedThreads).toBe(1);
    expect(read.commentIds).toEqual(["c1", "t1", "t2"]);
    expect(read.comments.map((c) => [c.id, c.author, c.path])).toEqual([["c1", "anna", undefined], ["t1", "bob", "src/a.ts"], ["t2", "anna", "src/b.ts"]]);
    expect(JSON.stringify(read)).not.toContain("body");
  });

  test("only collaborators count; bots and the gh user are left out", () => {
    const read = parseComments(answer(
      [
        node("c1", "stranger", { authorAssociation: "NONE" }),
        node("c2", "copilot", { author: { login: "copilot", __typename: "Bot" } }),
        node("c3", "me"),
        node("c4", "owner", { authorAssociation: "OWNER" }),
      ],
      [],
    ));
    expect(read.comments.map((c) => c.id)).toEqual(["c4"]);
    expect(read.commentIds).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("commentEvents: new comments as facts", () => {
  const comments = [
    { id: "c1", author: "anna", url: "u1" },
    { id: "t1", author: "bob", path: "src/a.ts", url: "u2" },
  ];

  test("only those not seen before, with who and where, never the text", () => {
    expect(commentEvents(["c1"], comments)).toEqual(["new review comment by bob on src/a.ts (u2)"]);
    expect(commentEvents([], comments)).toEqual(["new comment by anna (u1)", "new review comment by bob on src/a.ts (u2)"]);
  });

  test("at most three, then how many more", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, author: "anna", url: `u${i}` }));
    expect(commentEvents([], many)).toEqual(["new comment by anna (u0)", "new comment by anna (u1)", "new comment by anna (u2)", "and 2 more new comments"]);
  });
});

describe("bots' review comments (Copilot's reviewer) count; their conversation comments don't", () => {
  test("parsed with a bot mark", () => {
    const bot = { author: { login: "copilot-pull-request-reviewer", __typename: "Bot" }, authorAssociation: "NONE" };
    const read = parseComments(answer(
      [node("c1", "codecov", { author: { login: "codecov", __typename: "Bot" }, authorAssociation: "NONE" })],
      [{ isResolved: false, path: "src/a.ts", comments: { nodes: [node("t1", "x", bot), node("t2", "x", bot)] } }],
    ));
    expect(read.comments.map((c) => [c.id, c.author, c.bot])).toEqual([["t1", "copilot-pull-request-reviewer", true], ["t2", "copilot-pull-request-reviewer", true]]);
  });

  test("said once per bot, with how many and the first one's link", () => {
    const bots = ["t1", "t2", "t3"].map((id) => ({ id, author: "copilot-pull-request-reviewer", path: "a.ts", url: `u-${id}`, bot: true as const }));
    expect(commentEvents([], bots)).toEqual(["copilot-pull-request-reviewer left 3 review comments (u-t1)"]);
  });
});
