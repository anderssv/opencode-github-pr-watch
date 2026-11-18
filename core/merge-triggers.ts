import { parse } from "yaml";
import type { WorkflowRole } from "./workflow-role";

/** A workflow's `on:` section as event → settings; undefined when the file can't be read or has none. */
function eventsOf(file: string): Record<string, unknown> | undefined {
  let doc: unknown;
  try {
    doc = parse(file);
  } catch {
    return undefined;
  }
  // YAML 1.1 reads a bare `on` key as true, which some parsers keep; both spellings are accepted.
  const record = doc as Record<string, unknown> | null;
  const trigger = record?.on ?? record?.true;
  if (trigger === undefined || trigger === null) return undefined;
  return typeof trigger === "string" ? { [trigger]: null }
    : Array.isArray(trigger) ? Object.fromEntries(trigger.map((event) => [String(event), null]))
    : (trigger as Record<string, unknown>);
}

const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : undefined);

/** Whether an event's branch filters let the base branch through; without filters, every branch does. */
function forBranch(settings: unknown, base: string): boolean {
  const filters = (settings ?? {}) as { branches?: unknown; "branches-ignore"?: unknown };
  const branches = list(filters.branches);
  const ignored = list(filters["branches-ignore"]);
  if (branches) return branches.some((pattern) => matches(pattern, base));
  if (ignored) return !ignored.some((pattern) => matches(pattern, base));
  return true;
}

/**
 * Whether a merge into the base branch can start a workflow, read from its `on:` section: a push to that branch, or
 * another workflow finishing (a deploy chained after a build). Undefined when the file can't be read, so the caller
 * falls back to waiting for runs to show up.
 */
export function startsOnMerge(file: string, base: string): boolean | undefined {
  const events = eventsOf(file);
  if (!events) return undefined;
  if ("workflow_run" in events) return true;
  if (!("push" in events)) return false;
  const push = (events.push ?? {}) as { branches?: unknown; "branches-ignore"?: unknown; tags?: unknown };
  // Only tags given: pushes to branches don't start it.
  if (!list(push.branches) && !list(push["branches-ignore"]) && push.tags !== undefined) return false;
  return forBranch(push, base);
}

/** Whether a pull request into the base branch starts a workflow (`pull_request` or `pull_request_target`). */
export function startsOnPullRequest(file: string, base: string): boolean | undefined {
  const events = eventsOf(file);
  if (!events) return undefined;
  return ["pull_request", "pull_request_target"].some((event) => event in events && forBranch(events[event], base));
}

// GitHub's branch filters: `*` matches within a path segment, `**` across them. Negated patterns (`!x`) are left out.
function matches(pattern: string, branch: string): boolean {
  if (pattern.startsWith("!")) return false;
  const regex = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${regex}$`).test(branch);
}

/**
 * From the roles of the workflows a merge can start: false when none of them deploys (or there are none), true when
 * one does, undefined while one is still unjudged.
 */
export function deployPossible(roles: readonly (WorkflowRole | undefined)[]): boolean | undefined {
  if (roles.includes("deploy")) return true;
  return roles.includes(undefined) ? undefined : false;
}

/** The environments a workflow's jobs deploy to, in order, each once. Names set by an expression can't be known ahead. */
export function workflowEnvironments(file: string): string[] {
  let doc: unknown;
  try {
    doc = parse(file);
  } catch {
    return [];
  }
  const jobs = (doc as { jobs?: Record<string, { environment?: unknown }> } | null)?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  const names = Object.values(jobs).map((job) => {
    const env = job?.environment;
    return typeof env === "string" ? env : typeof env === "object" && env !== null ? (env as { name?: unknown }).name : undefined;
  });
  return [...new Set(names.filter((n): n is string => typeof n === "string" && !n.includes("${{")))];
}
