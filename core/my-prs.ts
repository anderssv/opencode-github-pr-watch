import type { CommentCount } from "./comments";

export interface MyPr {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
  readonly createdAt: string;
  /** Set for merged PRs: when they were merged. */
  readonly closedAt?: string;
  readonly comments?: CommentCount;
}

export interface SearchedPr {
  readonly repository: { readonly nameWithOwner: string };
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly closedAt?: string | null;
}

export const myPrFrom = (raw: SearchedPr): MyPr => ({
  repo: raw.repository.nameWithOwner,
  number: raw.number,
  title: raw.title,
  url: raw.url,
  draft: raw.isDraft,
  createdAt: raw.createdAt,
  // gh writes "no date" as year 1.
  ...(raw.closedAt && !raw.closedAt.startsWith("0001-") ? { closedAt: raw.closedAt } : {}),
});

const ownerOf = (repo: string) => repo.slice(0, repo.indexOf("/"));

export const organisationsOf = (prs: readonly MyPr[]): string[] => [...new Set(prs.map((pr) => ownerOf(pr.repo)))].sort();

export type MyPrSort = "name" | "newest" | "oldest";

// Merged PRs sort by when they merged, open ones by when they were opened.
const timeOf = (pr: MyPr) => Date.parse(pr.closedAt ?? pr.createdAt);
// Newest first; PRs from the same moment by number, the higher being the newer.
const newer = (a: MyPr, b: MyPr) => timeOf(b) - timeOf(a) || b.number - a.number;

/**
 * PRs grouped by repo, only one organisation's when given, and without drafts when `drafts` is false. By name: repos A–Z, newest PR first. By newest: the repo
 * with the most recent PR first, newest first. By oldest: the repo with the oldest PR first, oldest first.
 */
export function byRepo(prs: readonly MyPr[], organisation?: string, sort: MyPrSort = "name", drafts = true): { repo: string; prs: MyPr[] }[] {
  const groups = new Map<string, MyPr[]>();
  for (const pr of prs) {
    if (organisation && ownerOf(pr.repo) !== organisation) continue;
    if (!drafts && pr.draft) continue;
    groups.set(pr.repo, [...(groups.get(pr.repo) ?? []), pr]);
  }
  const oldestFirst = sort === "oldest";
  const listed = [...groups].map(([repo, list]) => ({
    repo,
    prs: [...list].sort((a, b) => (oldestFirst ? newer(b, a) : newer(a, b))),
  }));
  if (sort === "name") return listed.sort((a, b) => a.repo.localeCompare(b.repo));
  // Each repo's PRs are already in the chosen order, so its first PR decides where the repo goes.
  return listed.sort((a, b) => (oldestFirst ? newer(b.prs[0]!, a.prs[0]!) : newer(a.prs[0]!, b.prs[0]!)));
}

/** The first message of a session started for a PR from the side panel. */
export const prSessionPrompt = (pr: MyPr) => `PR #${pr.number} on ${pr.repo}: ${pr.title} (${pr.url}). Summarize it.`;

/** Every word of the search, in any case, is in the PR's title, repo or number ("#42" or "42"). */
export function matchesSearch(pr: MyPr, search: string): boolean {
  const haystack = `${pr.title} ${pr.repo} #${pr.number}`.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** A group's PRs for pasting: "- <title>: <url>", one per line. */
export const prList = (prs: readonly MyPr[]) => prs.map((pr) => `- ${pr.title}: ${pr.url}`).join("\n");

const PR_WATCH = /^(.+\/.+)#(\d+)$/;

/** My PRs plus the watched PRs I didn't open (a bot's, a colleague's), so one list holds both. */
export function withWatchedPrs<R extends { readonly id: string; readonly label: string; readonly url: string; readonly comments?: CommentCount }>(mine: readonly MyPr[], rows: readonly R[]): MyPr[] {
  const listed = new Set(mine.map((pr) => `${pr.repo}#${pr.number}`));
  const others = rows.flatMap((row) => {
    const match = row.id.match(PR_WATCH);
    if (!match || listed.has(row.id)) return [];
    return [{ repo: match[1]!, number: Number(match[2]), title: row.label.slice(row.id.length + 1), url: row.url, draft: false, createdAt: "", ...(row.comments ? { comments: row.comments } : {}) }];
  });
  return [...mine, ...others];
}

/** Watches of a workflow run without a PR. */
export const runWatches = <R extends { readonly id: string }>(rows: readonly R[]): R[] => rows.filter((row) => !PR_WATCH.test(row.id));

/** All PRs as one list: by repo then newest first ("name"), or by date; with the organisation and draft filters. */
export function allPrs(prs: readonly MyPr[], organisation?: string, sort: MyPrSort = "name", drafts = true): MyPr[] {
  return byRepo(prs, organisation, "name", drafts)
    .flatMap((group) => group.prs)
    .sort((a, b) => (sort === "name" ? 0 : sort === "oldest" ? newer(b, a) : newer(a, b)));
}

/** The PRs a given session watches. */
export function watchedIn<R extends { readonly id: string; readonly sessionID?: string }>(prs: readonly MyPr[], rows: readonly R[], sessionID: string): MyPr[] {
  const ids = new Set(rows.filter((row) => row.sessionID === sessionID).map((row) => row.id));
  return prs.filter((pr) => ids.has(`${pr.repo}#${pr.number}`));
}
