import type { MyPr } from "./my-prs";
import type { WatchRowLike } from "./prs-view";

/**
 * Everything the pill and the PRs tab show comes from this store, and it only changes through `update`: a full
 * refresh replaces the rows or the PR lists, and a single watch's check patches just its row. Both reach the same
 * data the same way, so the pill and the tab can't disagree.
 */
export interface Store<R extends WatchRowLike = WatchRowLike> {
  /** Every session's watches. */
  readonly rows: readonly R[];
  readonly rowsLoaded: boolean;
  /** The gh user's open PRs; absent until searched. */
  readonly open?: readonly MyPr[];
  /** Merged in the last 7 days; absent until asked for. */
  readonly merged?: readonly MyPr[];
  /** The gh user, to tell their PRs from others' among the watched ones. */
  readonly me?: string;
  /** Why every GitHub call is paused (a rate limit, the network), and until when. */
  readonly paused?: string;
}

export type Change<R extends WatchRowLike = WatchRowLike> =
  | { readonly kind: "rows"; readonly rows: readonly R[] }
  /** One watch checked (its new row), or stopped (no row). */
  | { readonly kind: "row"; readonly id: string; readonly row?: R }
  | { readonly kind: "prs"; readonly open: readonly MyPr[]; readonly merged?: readonly MyPr[] }
  | { readonly kind: "me"; readonly me: string }
  | { readonly kind: "paused"; readonly text?: string };

export const emptyStore = <R extends WatchRowLike>(): Store<R> => ({ rows: [], rowsLoaded: false });

export function update<R extends WatchRowLike>(store: Store<R>, change: Change<R>): Store<R> {
  switch (change.kind) {
    case "rows":
      return { ...store, rows: change.rows, rowsLoaded: true };
    case "row": {
      const at = store.rows.findIndex((r) => r.id === change.id);
      if (!change.row) return at < 0 ? store : { ...store, rows: store.rows.filter((r) => r.id !== change.id) };
      const rows = at < 0 ? [...store.rows, change.row] : store.rows.map((r, i) => (i === at ? change.row! : r));
      return { ...store, rows };
    }
    case "prs":
      return { ...store, open: change.open, ...(change.merged ? { merged: change.merged } : {}) };
    case "me":
      return { ...store, me: change.me };
    case "paused": {
      const { paused: _gone, ...rest } = store;
      return change.text ? { ...rest, paused: change.text } : rest;
    }
  }
}

/** What the pill shows: everything this session watches, the same rows the PRs tab shows for it. */
export const sessionRows = <R extends WatchRowLike>(rows: readonly R[], sessionID: string): R[] => rows.filter((row) => row.sessionID === sessionID);
