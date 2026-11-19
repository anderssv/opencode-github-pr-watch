import { OTHER } from "./topics";
/** Groups the user has collapsed in the PRs panel, kept as one global setting like the row buttons. */
export const COLLAPSED_GROUPS_KEY = "pr-watch/collapsed-groups";

/** A group is known by its kind, name and list (open or merged), so the same topic can be open in one list and closed in the other. */
export const groupKey = (kind: string, name: string, merged: boolean) => `${merged ? "merged" : "open"}:${kind}:${name}`;

export function readCollapsed(text: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export const toggleCollapsed = (collapsed: readonly string[], key: string): string[] =>
  collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];

/** The groups that exist (not only those shown: a search or filter hides groups without them being gone). */
export interface ExistingGroups {
  readonly list: "open" | "merged";
  readonly kind: string;
  readonly names: readonly string[];
}

/**
 * Forgets collapsed groups that no longer exist, so a group that goes away and comes back (or is renamed) is expanded.
 * Only lists and kinds that are known are judged: topics still loading, or a list not loaded, keep theirs.
 */
export function pruneCollapsed(collapsed: readonly string[], existing: readonly ExistingGroups[]): string[] {
  return collapsed.filter((key) => {
    const known = existing.find((e) => key.startsWith(`${e.list}:${e.kind}:`));
    return !known || known.names.includes(key.slice(`${known.list}:${known.kind}:`.length));
  });
}

/** The model's topics, and "Other", which code adds for PRs that got none, so a collapsed "Other" isn't taken as gone. */
export const topicGroupNames = (topics: readonly { readonly name: string }[]): string[] => [...new Set([...topics.map((t) => t.name), OTHER])];
