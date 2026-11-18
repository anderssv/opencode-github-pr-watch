import { describe, expect, test } from "bun:test";
import { emptyStore, sessionRows, update, type Store } from "../core/store";
import type { MyPr } from "../core/my-prs";

type R = { id: string; label: string; url: string; detail: string; tone: "pending"; sessionID: string };
const empty = (): Store<R> => emptyStore<R>();
const row = (id: string, detail = "x"): R => ({ id, label: id, url: "u", detail, tone: "pending" as const, sessionID: "s1" });
const pr = (n: number): MyPr => ({ repo: "o/r", number: n, title: `PR ${n}`, url: "u", draft: false, createdAt: "2026-11-10T10:00:00Z" });

describe("the store: one place the pill and the PRs tab read, changed only through update()", () => {
  test("a full refresh replaces every row", () => {
    const before = update(empty(), { kind: "rows", rows: [row("a"), row("b")] });
    const after = update(before, { kind: "rows", rows: [row("c")] });
    expect(after.rows.map((r) => r.id)).toEqual(["c"]);
    expect(after.rowsLoaded).toBe(true);
  });

  test("one watch checked: only its row changes, in place", () => {
    const before = update(empty(), { kind: "rows", rows: [row("a"), row("b")] });
    const after = update(before, { kind: "row", id: "a", row: row("a", "deploying 2/3") });
    expect(after.rows.map((r) => [r.id, r.detail])).toEqual([["a", "deploying 2/3"], ["b", "x"]]);
    expect(after.rows[1]).toBe(before.rows[1]);
  });

  test("a new watch is added, a stopped one goes", () => {
    const before = update(empty(), { kind: "rows", rows: [row("a")] });
    expect(update(before, { kind: "row", id: "b", row: row("b") }).rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(update(before, { kind: "row", id: "a" }).rows).toEqual([]);
  });

  test("PR lists: the merged list is kept when a refresh didn't ask for it", () => {
    const first = update(empty(), { kind: "prs", open: [pr(1)], merged: [pr(9)] });
    const next = update(first, { kind: "prs", open: [pr(2)] });
    expect(next.open?.map((p) => p.number)).toEqual([2]);
    expect(next.merged?.map((p) => p.number)).toEqual([9]);
  });

  test("the gh user", () => {
    expect(update(empty(), { kind: "me", me: "anna" }).me).toBe("anna");
  });
});

describe("the pill: everything this session watches", () => {
  test("its rows, in the store's order", () => {
    const rows = [row("a"), { ...row("b"), sessionID: "s2" }, row("c")];
    expect(sessionRows(rows, "s1").map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("the store knows when GitHub calls are paused", () => {
  test("set, and cleared when they aren't any more", () => {
    const paused = update(empty(), { kind: "paused", text: "GitHub is rate limiting; checking again at 12:05" });
    expect(paused.paused).toBe("GitHub is rate limiting; checking again at 12:05");
    expect(update(paused, { kind: "paused" }).paused).toBeUndefined();
  });
});
