import { allPrs, byRepo, matchesSearch, organisationsOf, runWatches, watchedIn, type MyPr, type MyPrSort } from "./my-prs";
import { byTopic, type Topic } from "./topics";

/**
 * What the PRs tab shows, decided from the loaded data and the user's choices. Pure: the GUI only renders the result,
 * so every rule here is tested without the app.
 */
export type Grouping = "repo" | "topic" | "none";

/** Where a line is, for the status filter: "needs-me" is everything a watch ends on because a person has to act. */
export type Status = "needs-me" | "review" | "approval" | "progress" | "done" | "unwatched";
export const ALL_STATUSES: readonly Status[] = ["needs-me", "review", "approval", "progress", "done", "unwatched"];
export const STATUS_LABELS: Record<Status, string> = {
  "needs-me": "Needs me",
  review: "Waiting for review",
  approval: "Waiting for approval",
  progress: "In progress",
  done: "Done",
  unwatched: "Not watched",
};

/** The chosen statuses after ticking or unticking one, or "all". */
export function toggleStatus(chosen: readonly Status[], status: Status | "all", on: boolean): readonly Status[] {
  if (status === "all") return on ? ALL_STATUSES : [];
  return ALL_STATUSES.filter((s) => (s === status ? on : chosen.includes(s)));
}

/** The status dropdown's button text. */
export function statusSummary(chosen: readonly Status[]): string {
  if (chosen.length === ALL_STATUSES.length) return "Status: All";
  if (chosen.length === 0) return "Status: None";
  return chosen.length === 1 ? `Status: ${STATUS_LABELS[chosen[0]!]}` : `Status: ${chosen.length} of ${ALL_STATUSES.length}`;
}

export function statusOf(row: { readonly tone?: string; readonly waitingFor?: string } | undefined): Status {
  if (!row) return "unwatched";
  if (row.waitingFor === "code-review") return "review";
  if (row.waitingFor === "run-approval") return "approval";
  return row.tone === "pending" ? "progress" : row.tone === "done" ? "done" : "needs-me";
}

export interface PrsChoices {
  readonly organisation: string;
  readonly grouping: Grouping;
  readonly sort: MyPrSort;
  readonly drafts: boolean;
  readonly others: boolean;
  readonly sessionOnly: boolean;
  readonly search: string;
  readonly statuses: readonly Status[];
}

export interface WatchRowLike {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly sessionID?: string;
  readonly tone?: string;
  readonly waitingFor?: string;
  readonly author?: string;
  readonly state?: string;
  readonly draft?: boolean;
  readonly forPr?: string;
}

/** The store's data (see store.ts): every session's watches, and the gh user's PRs as searched. */
export interface PrsData<R extends WatchRowLike> {
  /** Absent until searched. */
  readonly open?: readonly MyPr[];
  /** Absent until the recently merged list has been loaded. */
  readonly merged?: readonly MyPr[];
  readonly rows: readonly R[];
  /** The gh user; without it, a watched PR counts as theirs only when the search found it. */
  readonly me?: string;
}

export interface PrGroup {
  readonly name: string;
  readonly kind: "repo" | "topic" | "all";
  readonly prs: readonly MyPr[];
}

export interface PrsView<R extends WatchRowLike> {
  readonly runs: readonly R[];
  readonly open: readonly PrGroup[];
  readonly openEmpty?: string;
  readonly merged?: readonly PrGroup[];
  readonly mergedEmpty?: string;
  readonly organisations: readonly string[];
  /** The sort in effect: by name means nothing for topics, which then go newest first. */
  readonly effectiveSort: MyPrSort;
  readonly sortByNameDisabled: boolean;
  /** Each line names its repo unless the list is grouped by repo. */
  readonly repoOnLine: boolean;
  readonly watchOf: (pr: MyPr) => R | undefined;
}

export function prsView<R extends WatchRowLike>(data: PrsData<R>, choices: PrsChoices, sessionID: string, topics?: readonly Topic[]): PrsView<R> {
  const rows = data.rows;
  const searched = data.open ?? [];
  const found = new Set(searched.map(idOf));
  const mine = (row: R) => (data.me ? row.author === data.me : found.has(row.id));
  // Watched PRs the search didn't list: others' (when shown), and merged ones still on their way (deploying, waiting
  // for approval), which stay with the open ones until their watch is done.
  const watchedExtra = rows.filter(
    (row) =>
      PR_ROW.test(row.id) && !found.has(row.id) &&
      (row.state === "MERGED" ? row.tone !== "done" : row.state !== "CLOSED") &&
      (mine(row) || choices.others),
  );
  const listed = [...searched, ...watchedExtra.map(prOfWatch)];
  const shownOpen = new Set(listed.map(idOf));
  // With "current session only", just the PRs this session watches.
  const open = choices.sessionOnly ? watchedIn(listed, rows, sessionID) : listed;
  const recent = data.merged?.filter((pr) => !shownOpen.has(idOf(pr)));
  const merged = recent && (choices.sessionOnly ? watchedIn(recent, rows, sessionID) : recent);
  const byTopicNow = choices.grouping === "topic" && topics !== undefined;
  const effectiveSort: MyPrSort = choices.grouping === "topic" && choices.sort === "name" ? "newest" : choices.sort;
  const organisation = choices.organisation || undefined;

  // A PR's own watch, else a watched run on its branch.
  const watched = new Map([...rows.filter((row) => row.forPr).map((row) => [row.forPr!, row] as const), ...rows.map((row) => [row.id, row] as const)]);
  const watchOf = (pr: MyPr) => watched.get(`${pr.repo}#${pr.number}`);
  const shownStatus = (row: WatchRowLike | undefined) => choices.statuses.includes(statusOf(row));
  const group = (prs: readonly MyPr[]): PrGroup[] => {
    const found = prs.filter((pr) => matchesSearch(pr, choices.search) && shownStatus(watchOf(pr)));
    if (choices.grouping === "none") {
      const all = allPrs(found, organisation, choices.sort, choices.drafts);
      return all.length > 0 ? [{ name: "All PRs", kind: "all", prs: all }] : [];
    }
    if (byTopicNow) return byTopic(found, topics!, organisation, effectiveSort, choices.drafts).map((g) => ({ ...g, kind: "topic" as const }));
    return byRepo(found, organisation, choices.sort, choices.drafts).map((g) => ({ name: g.repo, kind: "repo" as const, prs: g.prs }));
  };

  const listedIds = new Set([...open, ...(merged ?? [])].map(idOf));
  const searching = choices.search.trim() !== "" || choices.statuses.length < ALL_STATUSES.length;
  const openGroups = group(open);
  const mergedGroups = merged && group(merged);
  return {
    // A run whose PR is listed shows on the PR's line instead.
    runs: runWatches(rows).filter((row) => !(row.forPr && listedIds.has(row.forPr)) && (!choices.sessionOnly || row.sessionID === sessionID) && shownStatus(row)),
    open: openGroups,
    ...(openGroups.length === 0
      ? { openEmpty: searching ? "No open PRs match." : choices.sessionOnly ? "No PRs watched in this session." : "No open PRs." }
      : {}),
    ...(mergedGroups ? { merged: mergedGroups } : {}),
    ...(mergedGroups && mergedGroups.length === 0 ? { mergedEmpty: searching ? "None match." : "None." } : {}),
    organisations: organisationsOf([...open, ...(merged ?? [])]),
    effectiveSort,
    sortByNameDisabled: choices.grouping === "topic",
    repoOnLine: byTopicNow || choices.grouping === "none",
    watchOf,
  };
}

export const CHOICE_KEYS = {
  organisation: "pr-watch.my-prs.organisation",
  grouping: "pr-watch.my-prs.grouping",
  sort: "pr-watch.my-prs.sort",
  drafts: "pr-watch.my-prs.drafts",
  others: "pr-watch.my-prs.others",
  sessionOnly: "pr-watch.my-prs.session-only",
  statuses: "pr-watch.my-prs.statuses",
} as const;

const GROUPINGS: readonly Grouping[] = ["repo", "topic", "none"];
const SORTS: readonly MyPrSort[] = ["name", "newest", "oldest"];

/** The stored choices, with defaults for anything missing or unknown. The search is never stored. */
export function readChoices(stored: (key: string) => string | null): PrsChoices {
  const grouping = stored(CHOICE_KEYS.grouping);
  const sort = stored(CHOICE_KEYS.sort);
  return {
    organisation: stored(CHOICE_KEYS.organisation) ?? "",
    grouping: GROUPINGS.find((g) => g === grouping) ?? "repo",
    sort: SORTS.find((s) => s === sort) ?? "name",
    drafts: stored(CHOICE_KEYS.drafts) !== "false",
    others: stored(CHOICE_KEYS.others) !== "false",
    sessionOnly: stored(CHOICE_KEYS.sessionOnly) === "true",
    search: "",
    statuses: readStatuses(stored(CHOICE_KEYS.statuses)),
  };
}

/**
 * Choices are kept per session (key + "/" + session id). The last choice made anywhere is also kept under the plain
 * key, as the start for sessions that haven't chosen yet.
 */
export function readSessionChoices(stored: (key: string) => string | null, sessionID: string): PrsChoices {
  return readChoices((key) => stored(`${key}/${sessionID}`) ?? stored(key));
}

/** The storage writes for one choice: the session's own, and the start for new sessions. */
export function choiceWrites<K extends keyof PrsChoices>(key: K, value: PrsChoices[K], sessionID: string): [string, string][] {
  if (!(key in CHOICE_KEYS)) return [];
  const plain = CHOICE_KEYS[key as keyof typeof CHOICE_KEYS];
  const text = Array.isArray(value) ? value.join(",") : String(value);
  return [[`${plain}/${sessionID}`, text], [plain, text]];
}

/** Stored as a comma list; unknown entries are dropped, and nothing stored means all. */
function readStatuses(stored: string | null): readonly Status[] {
  if (stored === null) return ALL_STATUSES;
  const chosen = stored.split(",");
  return ALL_STATUSES.filter((status) => chosen.includes(status));
}

const PR_ROW = /^(.+)#(\d+)$/;
const idOf = (pr: MyPr) => `${pr.repo}#${pr.number}`;

/** A watched PR as a list entry, from its row: the watch knows no opening date. */
function prOfWatch(row: WatchRowLike): MyPr {
  const [, repo, number] = row.id.match(PR_ROW)!;
  return { repo: repo!, number: Number(number), title: row.label.slice(row.id.length + 1), url: row.url, draft: row.draft ?? false, createdAt: "" };
}
