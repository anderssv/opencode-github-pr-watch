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
