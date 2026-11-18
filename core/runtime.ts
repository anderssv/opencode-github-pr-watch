import type { GithubHealth } from "./github-health";
// OpenCode runs setup again for every plugin instance and reload in the same process (one per location, and again
// whenever the host rebuilds its plugin scope). Anything that must happen once per process, such as announcing resumed
// watches or owning the poll loop, is kept here, outside any one instance.
export interface ProcessState {
  /** Directories whose watches have already been resumed in this process. */
  readonly resumed: Set<string>;
  /** The instance that currently runs the poll loop for a directory. */
  readonly owners: Map<string, symbol>;
  /** The poll timers of each directory, shared so a new owner can cancel the previous owner's loop. */
  readonly timers: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
  /** Each directory's "check every watch now", registered by the instance that owned the loop then. */
  readonly checkers: Map<string, { readonly owner: symbol; readonly run: () => void; readonly schedule?: (id: string, delayMs: number) => void }>;
  lastCheckNowAt?: number;
  /** Orphaned watches and the directory whose loop took each over. */
  readonly orphans: Map<string, string>;
  /** Watches being checked right now, by any instance in the process. */
  readonly checking: Set<string>;
  /** GitHub rate limiting or out of reach: every call waits until this is over. */
  github?: GithubHealth;
}

export const newProcessState = (): ProcessState => ({ resumed: new Set(), owners: new Map(), timers: new Map(), checkers: new Map(), orphans: new Map(), checking: new Set() });

const KEY = Symbol.for("opencode-pr-watch/process");

// On globalThis, because the host may import the module afresh for each instance.
export const processState = (): ProcessState => {
  const global = globalThis as unknown as Record<symbol, ProcessState | undefined>;
  const state = (global[KEY] ??= newProcessState());
  // A state made by an older version of this module (kept across a hot reload) lacks the newer fields.
  (state as { checkers?: ProcessState["checkers"] }).checkers ??= new Map();
  (state as { orphans?: ProcessState["orphans"] }).orphans ??= new Map();
  (state as { checking?: ProcessState["checking"] }).checking ??= new Set();
  return state;
};

/** Makes `owner` the only poll loop for the directory and returns its (emptied) timer map. */
export function claimPolling(state: ProcessState, directory: string, owner: symbol): Map<string, ReturnType<typeof setTimeout>> {
  state.owners.set(directory, owner);
  const timers = state.timers.get(directory) ?? new Map<string, ReturnType<typeof setTimeout>>();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  state.timers.set(directory, timers);
  return timers;
}

export const ownsPolling = (state: ProcessState, directory: string, owner: symbol) => state.owners.get(directory) === owner;

/** Stops the loop on dispose, unless a newer instance has already taken it over. */
export function releasePolling(state: ProcessState, directory: string, owner: symbol): void {
  if (!ownsPolling(state, directory, owner)) return;
  state.owners.delete(directory);
  for (const timer of state.timers.get(directory)?.values() ?? []) clearTimeout(timer);
  state.timers.get(directory)?.clear();
}

/**
 * Whether this setup should announce resumed watches: only the first setup per directory in a process does, and only
 * when the message differs from the last one sent to that session.
 */
export function shouldAnnounceResume(state: ProcessState, directory: string): boolean {
  if (state.resumed.has(directory)) return false;
  state.resumed.add(directory);
  return true;
}

export const resumeChanged = (lastSent: string | undefined, message: string) => lastSent !== message;

/** Queued messages are "<owner/repo#pr>: <text>"; drops those about a PR that is no longer watched. */
export const dropMessagesFor = (messages: readonly string[], id: string) => messages.filter((m) => !m.startsWith(`${id}: `));

const CHECK_NOW_EVERY_MS = 20_000;

export function onCheckNow(state: ProcessState, directory: string, owner: symbol, run: () => void, schedule?: (id: string, delayMs: number) => void): void {
  state.checkers.set(directory, { owner, run, ...(schedule ? { schedule } : {}) });
}

/**
 * An instance that has been replaced (the server part reloaded) can still start a watch from a tool call it was
 * already handling; its own loop is gone, so the watch goes to the loop of the instance that owns the directory now.
 */
export function handToOwner(state: ProcessState, directory: string, id: string, delayMs: number): boolean {
  const checker = state.checkers.get(directory);
  if (!checker?.schedule || state.owners.get(directory) !== checker.owner) return false;
  checker.schedule(id, delayMs);
  return true;
}

/** Runs every loop's check now, unless that was asked less than 20 seconds ago. Returns whether it ran. */
export function requestChecks(state: ProcessState, now: number): boolean {
  if (state.lastCheckNowAt !== undefined && now - state.lastCheckNowAt < CHECK_NOW_EVERY_MS) return false;
  state.lastCheckNowAt = now;
  for (const [directory, checker] of state.checkers) if (state.owners.get(directory) === checker.owner) checker.run();
  return true;
}

/** Every starting instance sees an orphaned watch; the first directory to claim it takes it over, the rest leave it. */
export function claimOrphan(state: ProcessState, id: string, directory: string): boolean {
  const claimed = state.orphans.get(id);
  if (claimed !== undefined) return claimed === directory;
  state.orphans.set(id, directory);
  return true;
}

/**
 * A reload starts a new instance that checks every watch at once, while the old one may still be checking the same
 * watch; both would read the same state and report the same change. Only one check of a watch runs at a time.
 */
export function beginCheck(state: ProcessState, id: string): boolean {
  if (state.checking.has(id)) return false;
  state.checking.add(id);
  return true;
}

export const endCheck = (state: ProcessState, id: string) => void state.checking.delete(id);
