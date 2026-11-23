import type { MyPr } from "./my-prs";

/** Texts the pill and the PRs tab show, worked out here so the GUI only renders them. */

const age = (iso: string, now: number) => {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "today" : days === 1 ? "1 day" : `${days} days`;
};

/** A PR line's second line: the watch's status, if watched, then how old it is. Others' PRs come without a date. */
export function lineDetail(pr: MyPr, merged: boolean, watchDetail: string | undefined, now: number): string {
  const when =
    merged && pr.closedAt ? `merged ${age(pr.closedAt, now)} ago` : pr.createdAt ? `${pr.draft ? "draft · " : ""}open ${age(pr.createdAt, now)}` : "";
  return [watchDetail, when].filter(Boolean).join(" · ");
}

/** The PR a watch row is about; a run watch has none. */
export function prOfRow(row: { readonly id: string; readonly label: string; readonly url: string }): Pick<MyPr, "repo" | "number" | "title" | "url"> | undefined {
  const match = row.id.match(/^(.+)#(\d+)$/);
  return match ? { repo: match[1]!, number: Number(match[2]), title: row.label.slice(row.id.length + 1), url: row.url } : undefined;
}

export type Tone = "pending" | "waiting" | "failed" | "done";

/** The pill: how many PRs the session watches, coloured by the one needing attention most. */
export function pillView(rows: readonly { readonly tone: Tone }[]): { label: string; worst: "pending" | "waiting" | "failed" } | undefined {
  if (rows.length === 0) return undefined;
  const worst = rows.some((r) => r.tone === "failed") ? "failed" : rows.some((r) => r.tone === "waiting") ? "waiting" : "pending";
  return { label: `${rows.length} PR${rows.length === 1 ? "" : "s"} watched`, worst };
}

/** The pill's lines for copying as a list: a PR by its title, a run (no PR) by its label, each with its link. */
export const copyItems = (rows: readonly { readonly id: string; readonly label: string; readonly url: string }[]): Pick<MyPr, "title" | "url">[] =>
  rows.map((row) => ({ title: prOfRow(row)?.title ?? row.label, url: row.url }));
