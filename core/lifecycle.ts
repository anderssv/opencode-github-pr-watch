import type { Watch } from "./watcher";

const ORPHAN_AFTER_MS = 15 * 60_000;

/** A PR unwatched in a session is not restarted there by a merge, rerun or branch update; only an explicit watch_pr does. */
export const automaticStartAllowed = (start: { readonly automatic: boolean; readonly unwatchedAt?: number }) =>
  !start.automatic || start.unwatchedAt === undefined;

/**
 * A start reads the PR before it stores the watch, which takes seconds. An unwatch in that time (right after
 * `gh pr merge`, which starts one) must win, or the watch it meant to stop runs anyway.
 */
export const stillWanted = (start: { readonly startedAt: number; readonly unwatchedAt?: number }) =>
  start.unwatchedAt === undefined || start.unwatchedAt < start.startedAt;

/** Queued messages are "<owner/repo#pr>: <text>"; drops those about PRs that have been unwatched. */
export const dropUnwatched = (messages: readonly string[], unwatched: ReadonlyMap<string, number>) =>
  messages.filter((message) => !unwatched.has(message.slice(0, message.indexOf(": "))));

/**
 * Each plugin instance polls the watches pinned to its own directory. After a restart, a directory no session has
 * opened again has no instance, and its watches would sit unchecked without a word; another instance takes them over.
 */
export const isOrphaned = (watch: Watch, directory: string, now: number) =>
  watch.pinned.directory !== directory && now - (watch.lastCheckedAt ?? watch.startedAt) > ORPHAN_AFTER_MS;

const FRESH_TRIGGER_MS = 5 * 60_000;

/**
 * Triggers are seen when the whole shell command finishes. After a long one (`gh run rerun …; gh run watch …`) the
 * rerun or update has already played out, so waiting for it would hide the result; the watch starts without it.
 */
export const freshTrigger = <T>(trigger: T, command: { readonly startedAt?: number; readonly finishedAt: number }): T | undefined =>
  command.startedAt === undefined || command.finishedAt - command.startedAt <= FRESH_TRIGGER_MS ? trigger : undefined;

/**
 * A merge or rerun on a PR this session already watches continues that watch, with its batch, instead of replacing
 * it with a new one and a second start note. An explicit watch_pr is a new intent and replaces it.
 */
export const keepExisting = (start: { readonly automatic: boolean; readonly sessionID: string; readonly existing?: { readonly sessionID: string } }) =>
  start.automatic && start.existing?.sessionID === start.sessionID;

/**
 * A check reads the watch, works for seconds, then saves its result. What a run attachment or a trigger stored on the
 * watch in between would be overwritten by that save, so it is carried over.
 */
export function keepConcurrentChanges(before: Watch, stored: Watch, checked: Watch): Watch {
  let next = checked;
  const added = (stored.runs ?? []).filter((run) => !(before.runs ?? []).includes(run));
  if (added.length > 0) next = { ...next, runs: [...(next.runs ?? []).filter((run) => !added.includes(run)), ...added] };
  if (stored.awaiting !== before.awaiting && stored.awaiting) next = { ...next, awaiting: stored.awaiting };
  if (stored.expectedCommitSince !== before.expectedCommitSince && stored.expectedCommitSince !== undefined) next = { ...next, expectedCommitSince: stored.expectedCommitSince };
  return next;
}
