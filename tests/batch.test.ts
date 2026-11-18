import { describe, expect, test } from "bun:test";
import { batchLabel, batchProgress, composeDigest, parsePrReferences, replaceMember, withoutMember } from "../core/batch";
import { aFacts } from "./mothers";

const NOW = Date.parse("2026-10-12T10:30:00Z");

describe("parsePrReferences", () => {
  test("reads several references separated by spaces, commas or newlines", () => {
    expect(parsePrReferences("o/a#1, o/b#2\nhttps://github.com/o/c/pull/3 4")).toEqual({
      refs: [{ repo: "o/a", pr: 1 }, { repo: "o/b", pr: 2 }, { repo: "o/c", pr: 3 }, { pr: 4 }],
      invalid: [],
    });
  });

  test("reports what it could not read", () => {
    expect(parsePrReferences("o/a#1 latest")).toEqual({ refs: [{ repo: "o/a", pr: 1 }], invalid: ["latest"] });
  });
});

describe("batchLabel", () => {
  test("uses the shared title", () => {
    expect(batchLabel(["fix(trivy): suppress libexpat CVE", "fix(trivy): suppress libexpat CVE"])).toBe("fix(trivy): suppress libexpat CVE");
  });

  test("falls back to the number of PRs", () => {
    expect(batchLabel(["a", "b", "c"])).toBe("3 PRs");
  });
});

describe("batchProgress", () => {
  test("counts approved, merged and deployed", () => {
    const facts = [
      aFacts({ review: "REVIEW_REQUIRED" }),
      aFacts({ review: "APPROVED" }),
      aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING" }),
      aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "SUCCEEDED" }),
      undefined,
    ];

    expect(batchProgress("libexpat fix", facts, NOW)).toBe("libexpat fix: approved 3/5 · merged 2/5 · deployed 1/5");
  });
});

describe("composeDigest", () => {
  test("a single message is passed on unchanged", () => {
    expect(composeDigest(["o/a#1: approved. summary: …"], [])).toBe("o/a#1: approved. summary: …");
  });

  test("several messages become one, with batch progress", () => {
    const digest = composeDigest(["o/a#1: approved.", "o/b#2: approved."], ["libexpat fix: approved 2/6 · merged 0/6 · deployed 0/6"]);

    expect(digest).toBe(
      ["2 PR updates:", "- o/a#1: approved.", "- o/b#2: approved.", "libexpat fix: approved 2/6 · merged 0/6 · deployed 0/6"].join("\n"),
    );
  });

  test("a single batch message still shows the batch progress", () => {
    const digest = composeDigest(["o/a#1: approved."], ["libexpat fix: approved 1/6 · merged 0/6 · deployed 0/6"]);

    expect(digest).toBe(["o/a#1: approved.", "libexpat fix: approved 1/6 · merged 0/6 · deployed 0/6"].join("\n"));
  });
});

describe("batch membership (plan 13)", () => {
  const batch = { label: "Bump x", members: ["o/r#1", "o/r#2"], facts: { "o/r#1": aFacts(), "o/r#2": aFacts() } };

  test("a closed PR is left out of the counts and shown apart", () => {
    expect(batchProgress("Bump x", [aFacts({ review: "APPROVED" }), aFacts({ state: "CLOSED" })], NOW)).toBe("Bump x: approved 1/1 · merged 0/1 · deployed 0/1 · closed 1");
  });

  test("a followed replacement takes the closed PR's place", () => {
    const replaced = replaceMember(batch, "o/r#1", "o/r#3", aFacts({ review: "APPROVED" }));
    expect(replaced.members).toEqual(["o/r#3", "o/r#2"]);
    expect(Object.keys(replaced.facts)).toEqual(["o/r#2", "o/r#3"]);
  });

  test("a PR started in a new batch leaves the old one", () => {
    const left = withoutMember(batch, "o/r#1");
    expect(left.members).toEqual(["o/r#2"]);
    expect(Object.keys(left.facts)).toEqual(["o/r#2"]);
  });

  test("identical progress lines show once", () => {
    expect(composeDigest(["o/r#1: merged"], ["Bump x: merged 1/2", "Bump x: merged 1/2"])).toBe("o/r#1: merged\nBump x: merged 1/2");
  });
});

describe("batch progress: a review that isn't required counts as approved", () => {
  test("approved when GitHub doesn't ask for a review", () => {
    expect(batchProgress("2 PRs", [aFacts({ review: "NOT_REQUIRED" }), aFacts({ review: "REVIEW_REQUIRED" })], 0)).toContain("approved 1/2");
  });
});
