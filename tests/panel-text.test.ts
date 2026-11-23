import { describe, expect, test } from "bun:test";
import { copyItems, lineDetail, pillView, prOfRow } from "../core/panel-text";
import { prList } from "../core/my-prs";
import type { MyPr } from "../core/my-prs";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const pr = (extra: Partial<MyPr> = {}): MyPr => ({ repo: "o/r", number: 7, title: "Fix", url: "u", draft: false, createdAt: "2026-11-14T10:00:00Z", ...extra });

describe("lineDetail: the second line of a PR", () => {
  test("the watch's status, then how old the PR is", () => {
    expect(lineDetail(pr(), false, "waiting for code review", NOW)).toBe("waiting for code review · open 3 days");
    expect(lineDetail(pr({ draft: true, createdAt: "2026-11-17T08:00:00Z" }), false, undefined, NOW)).toBe("draft · open today");
    expect(lineDetail(pr({ createdAt: "2026-11-16T08:00:00Z" }), false, undefined, NOW)).toBe("open 1 day");
  });

  test("merged PRs say when they merged; watched PRs of others have no date", () => {
    expect(lineDetail(pr({ closedAt: "2026-11-15T10:00:00Z" }), true, undefined, NOW)).toBe("merged 2 days ago");
    expect(lineDetail(pr({ createdAt: "" }), false, "deploying 3/8", NOW)).toBe("deploying 3/8");
  });
});

describe("prOfRow: the PR a watch row is about", () => {
  test("a PR watch, and none for a run watch", () => {
    expect(prOfRow({ id: "o/r#7", label: "o/r#7 Fix the thing", url: "u" })).toEqual({ repo: "o/r", number: 7, title: "Fix the thing", url: "u" });
    expect(prOfRow({ id: "o/r run 9", label: "o/r run 9 Deploy", url: "u" })).toBeUndefined();
  });
});

describe("pillView: the pill above the composer", () => {
  test("how many, coloured by what needs attention most; nothing without watches", () => {
    expect(pillView([])).toBeUndefined();
    expect(pillView([{ tone: "pending" }])).toEqual({ label: "1 PR watched", worst: "pending" });
    expect(pillView([{ tone: "pending" }, { tone: "waiting" }])).toEqual({ label: "2 PRs watched", worst: "waiting" });
    expect(pillView([{ tone: "waiting" }, { tone: "failed" }, { tone: "done" }])).toEqual({ label: "3 PRs watched", worst: "failed" });
  });
});

describe("copyItems: the pill's lines as a list to copy", () => {
  test("PRs by title, runs by their name, each with its link", () => {
    const rows = [
      { id: "o/r#7", label: "o/r#7 Fix the build", url: "https://github.com/o/r/pull/7" },
      { id: "o/r run 99", label: "MAIN - Deployment pipeline", url: "https://github.com/o/r/actions/runs/99" },
    ];
    expect(prList(copyItems(rows))).toBe("- Fix the build: https://github.com/o/r/pull/7\n- MAIN - Deployment pipeline: https://github.com/o/r/actions/runs/99");
  });
});
