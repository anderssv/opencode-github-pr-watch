import { describe, expect, test } from "bun:test";
import { beginCheck, claimOrphan, endCheck, claimPolling, dropMessagesFor, handToOwner, newProcessState, onCheckNow, ownsPolling, releasePolling, requestChecks, resumeChanged, shouldAnnounceResume } from "../core/runtime";

describe("resume announcements", () => {
  test("only the first setup for a directory in a process announces resumed watches", () => {
    const state = newProcessState();

    const answers = Array.from({ length: 6 }, () => shouldAnnounceResume(state, "/repo"));

    expect(answers).toEqual([true, false, false, false, false, false]);
  });

  test("each directory announces once", () => {
    const state = newProcessState();

    expect(shouldAnnounceResume(state, "/a")).toBe(true);
    expect(shouldAnnounceResume(state, "/b")).toBe(true);
  });

  test("an identical message to the last one sent is not repeated", () => {
    expect(resumeChanged("resumed 1 watch after restart: o/r#1", "resumed 1 watch after restart: o/r#1")).toBe(false);
    expect(resumeChanged("resumed 1 watch after restart: o/r#1", "resumed 2 watches after restart: o/r#1, o/r#2")).toBe(true);
    expect(resumeChanged(undefined, "resumed 1 watch after restart: o/r#1")).toBe(true);
  });
});

describe("poll loop ownership", () => {
  test("a new setup takes over the loop and cancels the previous instance's timers", () => {
    const state = newProcessState();
    const first = Symbol("first");
    const second = Symbol("second");
    let fired = false;
    claimPolling(state, "/repo", first).set("o/r#1", setTimeout(() => (fired = true), 5));

    const timers = claimPolling(state, "/repo", second);

    expect(timers.size).toBe(0);
    expect(ownsPolling(state, "/repo", first)).toBe(false);
    expect(ownsPolling(state, "/repo", second)).toBe(true);
    return new Promise<void>((done) => setTimeout(() => (expect(fired).toBe(false), done()), 20));
  });

  test("disposing a replaced instance leaves the new loop running", () => {
    const state = newProcessState();
    const first = Symbol("first");
    const second = Symbol("second");
    claimPolling(state, "/repo", first);
    const timers = claimPolling(state, "/repo", second);
    timers.set("o/r#1", setTimeout(() => undefined, 10_000));

    releasePolling(state, "/repo", first);

    expect(ownsPolling(state, "/repo", second)).toBe(true);
    expect(timers.size).toBe(1);
    releasePolling(state, "/repo", second);
    expect(timers.size).toBe(0);
  });
});

describe("dropMessagesFor", () => {
  test("drops queued messages about an unwatched PR, keeps the rest", () => {
    expect(dropMessagesFor(["o/r#1: approved", "o/r#12: merged", "o/r#1: deployed"], "o/r#1")).toEqual(["o/r#12: merged"]);
  });
});

describe("check now: the panel's reload asks every poll loop in the process to check its watches", () => {
  test("each directory's current owner checks; a replaced owner doesn't", () => {
    const state = newProcessState();
    const ran: string[] = [];
    const old = Symbol("old");
    const a = Symbol("a");
    const b = Symbol("b");
    claimPolling(state, "/a", old);
    onCheckNow(state, "/a", old, () => ran.push("old"));
    claimPolling(state, "/a", a);
    onCheckNow(state, "/a", a, () => ran.push("a"));
    claimPolling(state, "/b", b);
    onCheckNow(state, "/b", b, () => ran.push("b"));

    expect(requestChecks(state, 0)).toBe(true);
    expect(ran).toEqual(["a", "b"]);
  });

  test("asks again within 20 seconds are ignored, so repeated reloads don't flood GitHub", () => {
    const state = newProcessState();
    const ran: number[] = [];
    const owner = Symbol("o");
    claimPolling(state, "/a", owner);
    onCheckNow(state, "/a", owner, () => ran.push(1));

    expect(requestChecks(state, 1_000)).toBe(true);
    expect(requestChecks(state, 15_000)).toBe(false);
    expect(requestChecks(state, 21_000)).toBe(true);
    expect(ran).toEqual([1, 1]);
  });
});

describe("a watch scheduled by an instance that no longer owns the loop goes to the owner's loop", () => {
  test("handed to the current owner; the old instance schedules nothing itself", () => {
    const state = newProcessState();
    const old = Symbol("old");
    const current = Symbol("current");
    const scheduled: string[] = [];
    claimPolling(state, "/a", old);
    onCheckNow(state, "/a", old, () => undefined, (id) => scheduled.push(`old ${id}`));
    claimPolling(state, "/a", current);
    onCheckNow(state, "/a", current, () => undefined, (id, delay) => scheduled.push(`current ${id} ${delay}`));

    expect(handToOwner(state, "/a", "o/r#1", 0)).toBe(true);
    expect(scheduled).toEqual(["current o/r#1 0"]);
  });

  test("no owner yet: nobody to hand it to", () => {
    expect(handToOwner(newProcessState(), "/a", "o/r#1", 0)).toBe(false);
  });
});

describe("orphaned watches: one instance takes each over, not every one that starts", () => {
  test("the first directory to claim it keeps it; others leave it", () => {
    const state = newProcessState();
    expect(claimOrphan(state, "o/r#1", "/a")).toBe(true);
    expect(claimOrphan(state, "o/r#1", "/b")).toBe(false);
    expect(claimOrphan(state, "o/r#1", "/a")).toBe(true);
    expect(claimOrphan(state, "o/r#2", "/b")).toBe(true);
  });
});

describe("one check of a watch at a time, across instances in the process", () => {
  test("a second start while one runs is refused; after it ends, the next can start", () => {
    const state = newProcessState();
    expect(beginCheck(state, "o/r#1")).toBe(true);
    expect(beginCheck(state, "o/r#1")).toBe(false);
    expect(beginCheck(state, "o/r#2")).toBe(true);
    endCheck(state, "o/r#1");
    expect(beginCheck(state, "o/r#1")).toBe(true);
  });
});
