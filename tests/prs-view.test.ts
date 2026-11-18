import { describe, expect, test } from "bun:test";
import { ALL_STATUSES, CHOICE_KEYS, choiceWrites, prsView, readChoices, readSessionChoices, statusOf, statusSummary, toggleStatus, type PrsChoices } from "../core/prs-view";
import type { MyPr } from "../core/my-prs";

const pr = (repo: string, number: number, extra: Partial<MyPr> = {}): MyPr => ({
  repo, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, draft: false, createdAt: "2026-11-10T10:00:00Z", ...extra,
});
const row = (id: string, sessionID: string, extra: Record<string, unknown> = {}) => ({ id, label: `${id} title of ${id}`, url: `u/${id}`, sessionID, ...extra });

const choices = (overrides: Partial<PrsChoices> = {}): PrsChoices => ({
  organisation: "", grouping: "repo", sort: "name", drafts: true, others: true, sessionOnly: false, search: "", statuses: ALL_STATUSES, ...overrides,
});
const data = {
  open: [pr("o/b", 1), pr("o/a", 2, { draft: true }), pr("x/c", 3)],
  merged: [pr("o/a", 9, { closedAt: "2026-11-15T10:00:00Z" })],
  rows: [row("o/a#2", "s1"), row("bot/dep#7", "s2"), row("o/a run 5", "s1")],
};
const numbers = (groups: readonly { prs: readonly MyPr[] }[]) => groups.flatMap((g) => g.prs.map((p) => p.number));

describe("prsView: what the PRs tab shows", () => {
  test("by repo: my PRs and others' watched PRs, grouped by repo, runs apart", () => {
    const view = prsView(data, choices(), "s1");
    expect(view.open.map((g) => [g.kind, g.name])).toEqual([["repo", "bot/dep"], ["repo", "o/a"], ["repo", "o/b"], ["repo", "x/c"]]);
    expect(view.runs.map((r) => r.id)).toEqual(["o/a run 5"]);
    expect(view.repoOnLine).toBe(false);
  });

  test("filters: organisation, drafts, others, search", () => {
    expect(numbers(prsView(data, choices({ organisation: "o" }), "s1").open)).toEqual([2, 1]);
    expect(numbers(prsView(data, choices({ drafts: false, others: false }), "s1").open)).toEqual([1, 3]);
    expect(numbers(prsView(data, choices({ search: "#3" }), "s1").open)).toEqual([3]);
  });

  test("current session only: the PRs and runs this session watches, whoever opened them", () => {
    const view = prsView(data, choices({ sessionOnly: true }), "s2");
    expect(numbers(view.open)).toEqual([7]);
    expect(view.runs).toEqual([]);
    expect(prsView({ ...data, rows: [] }, choices({ sessionOnly: true }), "s2").openEmpty).toBe("No PRs watched in this session.");
  });

  test("current session only, without others' PRs: only my PRs this session watches", () => {
    const view = prsView({ ...data, rows: [...data.rows, row("bot/dep#7", "s1")] }, choices({ sessionOnly: true, others: false }), "s1");
    expect(numbers(view.open)).toEqual([2]);
  });

  test("no grouping: one list, lines show their repo", () => {
    const view = prsView(data, choices({ grouping: "none" }), "s1");
    expect(view.open.map((g) => [g.kind, g.name])).toEqual([["all", "All PRs"]]);
    expect(view.repoOnLine).toBe(true);
  });

  test("by topic: the topics' groups once they are there, by repo until then; sorting by name falls back to newest", () => {
    const topics = [{ name: "Deps", prs: ["bot/dep#7"] }];
    const waiting = prsView(data, choices({ grouping: "topic" }), "s1");
    expect(waiting.open[0]!.kind).toBe("repo");
    expect(waiting.sortByNameDisabled).toBe(true);
    expect(waiting.effectiveSort).toBe("newest");
    const ready = prsView(data, choices({ grouping: "topic" }), "s1", topics);
    expect(ready.open.map((g) => g.name)).toEqual(["Deps", "Other"]);
    expect(ready.repoOnLine).toBe(true);
  });

  test("recently merged: grouped the same way, absent until loaded, empty text when nothing matches", () => {
    expect(numbers(prsView(data, choices(), "s1").merged!)).toEqual([9]);
    expect(prsView({ ...data, merged: undefined }, choices(), "s1").merged).toBeUndefined();
    expect(prsView(data, choices({ search: "nothing" }), "s1").mergedEmpty).toBe("None match.");
  });

  test("empty texts say why", () => {
    expect(prsView({ open: [], rows: [] }, choices(), "s1").openEmpty).toBe("No open PRs.");
    expect(prsView(data, choices({ search: "zzz" }), "s1").openEmpty).toBe("No open PRs match.");
    expect(prsView(data, choices(), "s1").openEmpty).toBeUndefined();
  });

  test("organisations for the dropdown come from everything listed", () => {
    expect(prsView(data, choices(), "s1").organisations).toEqual(["bot", "o", "x"]);
  });

  test("a PR's watch row, if watched", () => {
    expect(prsView(data, choices(), "s1").watchOf(pr("o/a", 2))?.sessionID).toBe("s1");
    expect(prsView(data, choices(), "s1").watchOf(pr("o/b", 1))).toBeUndefined();
  });
});

describe("watched PRs come from their rows, with their real author", () => {
  const mine = (id: string, extra: Record<string, unknown> = {}) => row(id, "s1", { author: "me", state: "OPEN", tone: "waiting", ...extra });

  test("others' PRs only with 'Show PRs that aren't mine'; mine always, even when the search hasn't found them yet", () => {
    const data2 = { open: [], rows: [mine("o/a#5"), row("bot/dep#7", "s1", { author: "bot", state: "OPEN" })], me: "me" };
    expect(numbers(prsView(data2, choices({ others: false }), "s1").open)).toEqual([5]);
    expect(numbers(prsView(data2, choices(), "s1").open)).toEqual([7, 5]);
  });

  test("a merged PR still on its way stays with the open ones, not under recently merged; once done it moves there", () => {
    const merged = [pr("o/a", 9, { closedAt: "2026-11-15T10:00:00Z" })];
    const going = { open: [], merged, rows: [mine("o/a#9", { state: "MERGED", tone: "pending" })], me: "me" };
    expect(numbers(prsView(going, choices(), "s1").open)).toEqual([9]);
    expect(prsView(going, choices(), "s1").merged).toEqual([]);
    const done = { ...going, rows: [mine("o/a#9", { state: "MERGED", tone: "done" })] };
    expect(prsView(done, choices(), "s1").open).toEqual([]);
    expect(numbers(prsView(done, choices(), "s1").merged!)).toEqual([9]);
  });

  test("closed PRs aren't listed as open", () => {
    expect(prsView({ open: [], rows: [mine("o/a#5", { state: "CLOSED" })], me: "me" }, choices(), "s1").open).toEqual([]);
  });
});

describe("statuses: what a line's watch says about it", () => {
  test("from the watch's tone and what it waits for; no watch is not watched", () => {
    expect(statusOf(undefined)).toBe("unwatched");
    expect(statusOf({ tone: "failed" })).toBe("needs-me");
    expect(statusOf({ tone: "waiting" })).toBe("needs-me");
    expect(statusOf({ tone: "waiting", waitingFor: "code-review" })).toBe("review");
    expect(statusOf({ tone: "waiting", waitingFor: "run-approval" })).toBe("approval");
    expect(statusOf({ tone: "pending" })).toBe("progress");
    expect(statusOf({ tone: "pending", waitingFor: "run-approval" })).toBe("approval");
    expect(statusOf({ tone: "done" })).toBe("done");
  });

  test("ticking a status, or All for every one of them; the order stays the dropdown's", () => {
    expect(toggleStatus(["done"], "review", true)).toEqual(["review", "done"]);
    expect(toggleStatus(["review", "done"], "review", false)).toEqual(["done"]);
    expect(toggleStatus(["done"], "all", true)).toEqual(ALL_STATUSES);
    expect(toggleStatus(ALL_STATUSES, "all", false)).toEqual([]);
  });

  test("the dropdown says what is chosen", () => {
    expect(statusSummary(ALL_STATUSES)).toBe("Status: All");
    expect(statusSummary([])).toBe("Status: None");
    expect(statusSummary(["review"])).toBe("Status: Waiting for review");
    expect(statusSummary(["review", "done"])).toBe("Status: 2 of 6");
  });

  test("the filter keeps only lines with a chosen status, runs and merged PRs too", () => {
    const rows = [
      row("o/a#2", "s1", { tone: "waiting", waitingFor: "code-review" }),
      row("bot/dep#7", "s2", { tone: "failed" }),
      row("o/a run 5", "s1", { tone: "pending" }),
    ];
    const both = { ...data, rows: rows };
    expect(numbers(prsView(both, choices({ statuses: ["review"] }), "s1").open)).toEqual([2]);
    expect(numbers(prsView(both, choices({ statuses: ["needs-me", "unwatched"] }), "s1").open)).toEqual([7, 1, 3]);
    expect(prsView(both, choices({ statuses: ["review"] }), "s1").runs).toEqual([]);
    expect(prsView(both, choices({ statuses: ["progress"] }), "s1").runs.map((r) => r.id)).toEqual(["o/a run 5"]);
    expect(prsView(both, choices({ statuses: ["review"] }), "s1").merged).toEqual([]);
    expect(prsView(both, choices({ statuses: [] }), "s1").openEmpty).toBe("No open PRs match.");
  });
});

describe("choices per session", () => {
  const storage = (entries: Record<string, string>) => (key: string) => entries[key] ?? null;

  test("a session's own choices win over the last ones made anywhere", () => {
    const stored = storage({ [CHOICE_KEYS.grouping]: "topic", [`${CHOICE_KEYS.grouping}/s1`]: "none", [CHOICE_KEYS.drafts]: "false" });
    expect(readSessionChoices(stored, "s1")).toEqual(choices({ grouping: "none", drafts: false }));
  });

  test("a new session starts with the last choices made anywhere", () => {
    expect(readSessionChoices(storage({ [CHOICE_KEYS.grouping]: "topic" }), "s2")).toEqual(choices({ grouping: "topic" }));
  });

  test("a choice is stored for the session and as the start for new sessions; the search is never stored", () => {
    expect(choiceWrites("grouping", "topic", "s1")).toEqual([[`${CHOICE_KEYS.grouping}/s1`, "topic"], [CHOICE_KEYS.grouping, "topic"]]);
    expect(choiceWrites("statuses", ["review", "done"], "s1")).toEqual([[`${CHOICE_KEYS.statuses}/s1`, "review,done"], [CHOICE_KEYS.statuses, "review,done"]]);
    expect(choiceWrites("search", "x", "s1")).toEqual([]);
  });
});

describe("readChoices: the stored preferences, with defaults for anything missing or unknown", () => {
  test("defaults", () => {
    expect(readChoices(() => null)).toEqual(choices());
  });

  test("stored values, and unknown ones ignored", () => {
    const stored: Record<string, string> = {
      [CHOICE_KEYS.organisation]: "o", [CHOICE_KEYS.grouping]: "topic", [CHOICE_KEYS.sort]: "sideways",
      [CHOICE_KEYS.drafts]: "false", [CHOICE_KEYS.others]: "false", [CHOICE_KEYS.sessionOnly]: "true",
      [CHOICE_KEYS.statuses]: "review,bogus,done",
    };
    expect(readChoices((key) => stored[key] ?? null)).toEqual(
      choices({ organisation: "o", grouping: "topic", drafts: false, others: false, sessionOnly: true, statuses: ["review", "done"] }),
    );
    expect(readChoices((key) => (key === CHOICE_KEYS.statuses ? "" : null)).statuses).toEqual([]);
  });
});

describe("a run on a PR's branch shows on the PR's line", () => {
  const pr7 = pr("o/a", 7);
  const run = row("o/a run 5", "s1", { forPr: "o/a#7", tone: "pending" });

  test("the PR's line uses the run when the PR itself isn't watched, and the run isn't listed apart", () => {
    const view = prsView({ open: [pr7], rows: [run] }, choices(), "s1");
    expect(view.watchOf(pr7)?.id).toBe("o/a run 5");
    expect(view.runs).toEqual([]);
  });

  test("a watched PR keeps its own row; its run is still not listed apart", () => {
    const view = prsView({ open: [pr7], rows: [run, row("o/a#7", "s1")] }, choices(), "s1");
    expect(view.watchOf(pr7)?.id).toBe("o/a#7");
    expect(view.runs).toEqual([]);
  });

  test("a run whose PR isn't in the list stays under Workflow runs", () => {
    expect(prsView({ open: [], rows: [run] }, choices(), "s1").runs.map((r) => r.id)).toEqual(["o/a run 5"]);
  });
});
