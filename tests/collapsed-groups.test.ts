import { describe, expect, test } from "bun:test";
import { groupKey, readCollapsed, toggleCollapsed } from "../core/collapsed-groups";

describe("collapsed groups in the PRs panel", () => {
  test("a group is known by list, kind and name", () => {
    expect(groupKey("topic", "Java runtime upgrade", false)).toBe("open:topic:Java runtime upgrade");
    expect(groupKey("topic", "Java runtime upgrade", true)).not.toBe(groupKey("topic", "Java runtime upgrade", false));
  });

  test("toggling collapses, toggling again expands", () => {
    const key = groupKey("repo", "o/r", false);
    expect(toggleCollapsed([], key)).toEqual([key]);
    expect(toggleCollapsed([key], key)).toEqual([]);
  });

  test("what's stored is read back; anything else is nothing collapsed", () => {
    expect(readCollapsed(JSON.stringify(["open:repo:o/r"]))).toEqual(["open:repo:o/r"]);
    expect(readCollapsed(null)).toEqual([]);
    expect(readCollapsed("not json")).toEqual([]);
    expect(readCollapsed(JSON.stringify({ a: 1 }))).toEqual([]);
  });
});
