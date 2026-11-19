import { describe, expect, test } from "bun:test";
import { demoData, demoPort, type DemoRow } from "../core/demo";
import type { MyPr } from "../core/my-prs";
import { prsView, readChoices } from "../core/prs-view";
import { pillView } from "../core/panel-text";

const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("demo data: made-up PRs for screenshots", () => {
  test("fills every part of the tab and the pill", async () => {
    const port = demoPort(() => "ses_1", () => NOW);
    const loaded = { ...(await port.myPrs(true)), ...(await port.watches()) } as { open: MyPr[]; merged: MyPr[]; rows: DemoRow[]; me: string };
    const view = prsView(loaded, readChoices(() => null), "ses_1");
    expect(view.runs.length).toBe(1);
    expect(view.open.map((g) => g.name)).toEqual(["acme/api", "acme/infra", "acme/shop"]);
    expect(view.merged?.length).toBe(1);
    expect(view.merged?.[0]?.prs.length).toBeGreaterThanOrEqual(2);
    expect(pillView(demoData("ses_1", NOW).sessionRows)).toEqual({ label: "3 PRs watched", worst: "failed" });
  });

  test("topics cover every listed PR", async () => {
    const port = demoPort(() => "ses_1", () => NOW);
    const loaded = { ...(await port.myPrs(true)), ...(await port.watches()) } as { open: MyPr[]; merged: MyPr[]; rows: DemoRow[]; me: string };
    const topics = (await port.myPrTopics("ses_1", true)).flatMap((t) => t.prs);
    const view = prsView(loaded, { ...readChoices(() => null), grouping: "topic" }, "ses_1", await port.myPrTopics("ses_1", true));
    expect(view.open.map((g) => g.name)).not.toContain("Other");
    expect(topics.length).toBeGreaterThan(0);
  });

  test("only the made-up acme organisation", () => {
    const data = demoData("ses_1", NOW);
    const repos = [...data.open, ...(data.merged ?? [])].map((pr) => pr.repo).concat(data.rows.map((row) => row.id.split(/[# ]/)[0]!));
    expect(repos.every((repo) => repo.startsWith("acme/"))).toBe(true);
    expect(data.rows.every((row) => row.url.startsWith("https://github.com/acme/"))).toBe(true);
  });
});
