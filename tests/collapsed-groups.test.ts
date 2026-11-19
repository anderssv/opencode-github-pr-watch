import { describe, expect, test } from "bun:test";
import { groupKey, pruneCollapsed, readCollapsed, toggleCollapsed, topicGroupNames } from "../core/collapsed-groups";

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

describe("pruneCollapsed: a collapsed group that's gone comes back expanded", () => {
  const repo = groupKey("repo", "o/old", false);
  const topic = groupKey("topic", "Java runtime upgrade", false);

  test("a group whose name no longer exists is forgotten", () => {
    expect(pruneCollapsed([repo, topic], [{ list: "open", kind: "repo", names: ["o/new"] }, { list: "open", kind: "topic", names: ["Java runtime upgrade"] }])).toEqual([topic]);
  });

  test("only for what is known: topics not loaded yet, or a list not loaded, keep their collapsed groups", () => {
    expect(pruneCollapsed([repo, topic], [{ list: "open", kind: "repo", names: ["o/old"] }])).toEqual([repo, topic]);
    expect(pruneCollapsed([groupKey("repo", "o/x", true)], [{ list: "open", kind: "repo", names: [] }])).toEqual([groupKey("repo", "o/x", true)]);
  });
});

describe("topicGroupNames: the topic groups that can exist", () => {
  test("the model's topics, and Other, which code adds for the PRs it left out", () => {
    expect(topicGroupNames([{ name: "Deps", prs: [] }])).toEqual(["Deps", "Other"]);
    const other = groupKey("topic", "Other", false);
    expect(pruneCollapsed([other], [{ list: "open", kind: "topic", names: topicGroupNames([{ name: "Deps", prs: [] }]) }])).toEqual([other]);
  });
});
