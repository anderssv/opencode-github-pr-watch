import { describe, expect, test } from "bun:test";
import { formatWatch } from "../core/listing";
import { aFacts, aWatch } from "./mothers";

const snapshot = [
  "PR: fix: keep DB outages off request threads (https://github.com/acme/api/pull/42)",
  "state: MERGED",
  "review: APPROVED",
  "      job Build and test: completed success",
  "      job DEPLOY - Dev: completed success",
  "      job DEPLOY - Prod: in_progress",
].join("\n");

describe("formatWatch", () => {
  test("shows when the watch last checked and last saw a change", () => {
    const text = formatWatch(
      aWatch({ lastSnapshot: snapshot, lastCheckedAt: Date.UTC(2026, 9, 8, 11, 20, 0), lastChangeAt: Date.UTC(2026, 9, 8, 11, 15, 30) }),
    );

    expect(text).toContain("last checked 2026-10-08T11:20:00Z");
    expect(text).toContain("last change 2026-10-08T11:15:30Z");
  });

  test("shows the whole snapshot without a tail", () => {
    const text = formatWatch(aWatch({ lastSnapshot: snapshot }));

    expect(text).toContain("state: MERGED");
    expect(text).toContain("job DEPLOY - Prod: in_progress");
  });

  test("shows only the last lines with a tail, keeping the PR title line", () => {
    const text = formatWatch(aWatch({ lastSnapshot: snapshot }), 2);

    expect(text).toContain("PR: fix: keep DB outages off request threads");
    expect(text).toContain("(3 earlier lines omitted)");
    expect(text).toContain("job DEPLOY - Dev: completed success");
    expect(text).toContain("job DEPLOY - Prod: in_progress");
    expect(text).not.toContain("state: MERGED");
  });

  test("omits nothing when the tail covers the whole snapshot", () => {
    const text = formatWatch(aWatch({ lastSnapshot: snapshot }), 50);

    expect(text).toContain("state: MERGED");
    expect(text).not.toContain("omitted");
  });

  test("says when a watch has not been checked yet", () => {
    const text = formatWatch(aWatch(), 10);

    expect(text).toContain("last checked never");
    expect(text).toContain("(not checked yet)");
  });

  test("keeps the approval and up-to-date lines with a tail", () => {
    const withStatus = [
      "PR: feat: something (https://github.com/o/r/pull/7)",
      "state: OPEN",
      "approved: no (review required)",
      "up to date with main: no (behind, needs update from main)",
      "merge: BEHIND",
      "checks:",
      "  - Build and test: COMPLETED SUCCESS",
    ].join("\n");

    const text = formatWatch(aWatch({ lastSnapshot: withStatus }), 1);

    expect(text).toContain("approved: no (review required)");
    expect(text).toContain("up to date with main: no (behind, needs update from main)");
    expect(text).toContain("  - Build and test: COMPLETED SUCCESS");
    expect(text).toContain("(3 earlier lines omitted)");
    expect(text).not.toContain("state: OPEN");
  });

  test("keeps the summary line with a tail", () => {
    const withSummary = [
      "PR: feat: something (https://github.com/o/r/pull/7)",
      "summary: REVIEW_REQUIRED · checks PASS · branch OK · next: NEEDS_REVIEW",
      "state: OPEN",
      "checks:",
      "  - Build and test: COMPLETED SUCCESS",
    ].join("\n");

    const text = formatWatch(aWatch({ lastSnapshot: withSummary }), 1);

    expect(text).toContain("summary: REVIEW_REQUIRED · checks PASS · branch OK · next: NEEDS_REVIEW");
    expect(text).not.toContain("state: OPEN");
  });

  test("flags a watch whose last check is more than twice its poll interval ago", () => {
    const checked = Date.UTC(2026, 9, 15, 8, 35, 0);
    // A running build is polled every 30 seconds; stale after 5 minutes at the least.
    const watch = aWatch({ lastSnapshot: snapshot, lastCheckedAt: checked, lastFacts: aFacts({ checks: "PENDING" }) });

    expect(formatWatch(watch, undefined, checked + 7 * 60_000)).toContain("STALE: last checked 7 min ago");
    expect(formatWatch(watch, undefined, checked + 90_000)).not.toContain("STALE");
  });

  test("a watch waiting on people, polled every minute, is stale after 5 minutes too", () => {
    const checked = Date.UTC(2026, 9, 15, 8, 35, 0);
    const watch = aWatch({ lastSnapshot: snapshot, lastCheckedAt: checked, lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) });

    expect(formatWatch(watch, undefined, checked + 4 * 60_000)).not.toContain("STALE");
    expect(formatWatch(watch, undefined, checked + 11 * 60_000)).toContain("STALE: last checked 11 min ago");
  });
});

describe("the listing shows the track, like the pill", () => {
  test("after the timestamps, from the last facts", () => {
    const text = formatWatch(aWatch({ lastSnapshot: "PR: x\nsummary: y", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) }), undefined, Date.parse("2026-11-18T12:00:00Z"));
    expect(text.split("\n")[2]).toBe("track: Checks ✓ · Review ⏸ waiting for code review · Merge · Deploy");
  });

  test("none before the first check", () => {
    expect(formatWatch(aWatch({ lastFacts: undefined }))).not.toContain("track:");
  });
});
