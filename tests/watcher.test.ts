import { TRACK_VERSION } from "../core/progress";
import { SNAPSHOT_VERSION } from "../core/watcher";
import { describe, expect, test } from "bun:test";
import { awaitTrigger, judgePrompt, tick } from "../core/watcher";
import { aFacts, aSession, aSnapshot, aWatch, FakePorts, settings } from "./mothers";

const NOW = Date.parse("2026-10-15T10:30:00Z"); // a Thursday: reminders and review limits count working days
const fakePorts = (init: ConstructorParameters<typeof FakePorts>[0]) => {
  const ports = new FakePorts(init);
  ports.time = NOW;
  return ports;
};
// A PR still in a pipeline phase, so the watch keeps going.
const moving = { checks: "PENDING" as const };
const watchStarted = (overrides = {}) => aWatch({ startedAt: NOW - 60_000, lastChangeAt: NOW - 60_000, ...overrides });

describe("tick: fixed events, no model", () => {
  test("notifies an approval without asking the model, and keeps watching with auto-merge on", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("approved", { review: "APPROVED", autoMerge: true })] });

    const result = await tick(
      watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts({ review: "REVIEW_REQUIRED", autoMerge: true }) }),
      ports,
      settings(),
    );

    expect(ports.judged).toEqual([]);
    expect(ports.notifications).toEqual([{ sessionID: "ses_parent", text: expect.stringContaining("approved"), wake: false }]);
    expect(ports.notifications[0]!.text).toContain("summary: APPROVED");
    expect(result.stop).toBe(false);
  });

  test("ready for merge keeps watching: said once as a change of step, then it waits for the merge", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("approved", { review: "APPROVED" }), aSnapshot("approved", { review: "APPROVED" })] });

    const first = await tick(watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) }), ports, settings());
    expect(first.stop).toBe(false);
    expect(first.delayMs).toBe(30_000 - (NOW % 30_000) || 30_000);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("approved");
    expect(ports.notifications[0]!.text).toContain("ready to merge");

    const second = await tick(first.watch, ports, settings());
    expect(second.stop).toBe(false);
    expect(ports.notifications).toHaveLength(1);
  });

  test("the merge after ready leads into the deploy", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("merged", { state: "MERGED", mergedAt: NOW, deploy: "RUNNING" })] });
    const result = await tick(watchStarted({ lastSnapshot: "approved", lastFacts: aFacts() }), ports, settings());
    expect(result.stop).toBe(false);
    expect(ports.notifications.map((n) => n.text).join()).toContain("merged");
  });

  test("stops at an end state and says why", async () => {
    const before = aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" });
    const ports = fakePorts({ snapshots: [aSnapshot("deployed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "SUCCEEDED" })] });

    const result = await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: before }), ports, settings());

    expect(result.stop).toBe(true);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("deployed (merge pipeline succeeded)");
    expect(ports.notifications[0]!.text).toContain("watch stopped");
  });

  test("a failed deploy is said with the model's diagnosis, and the watch goes on for a rerun", async () => {
    // The model's diagnosis of the failure feeds the suggestion.
    const before = aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" });
    const ports = fakePorts({ snapshots: [aSnapshot("failed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "FAILED" })] });
    ports.diagnosis = { kind: "real", cause: "CVE in libexpat1" };

    const result = await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: before }), ports, settings());

    expect(result.stop).toBe(false);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("the merge pipeline failed");
    expect(ports.notifications[0]!.text).toContain("suggestion: fix needed: CVE in libexpat1");
  });

  test("a step after the deploy failed: says the service was deployed (event-bridge#293)", async () => {
    const before = aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" });
    const ports = fakePorts({ snapshots: [aSnapshot("failed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "FAILED" })] });
    ports.diagnosis = { kind: "real", cause: "Register release failed in DEPLOY - Prod", afterDeploy: true };

    await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: before }), ports, settings());

    const text = ports.notifications[0]!.text;
    expect(text).toContain("deployed, but a step after the deploy failed");
    expect(text).not.toContain("watch stopped");
    expect(text).not.toContain("the merge pipeline failed");
    expect(text).toContain("Register release failed in DEPLOY - Prod");
  });

  test("keeps watching a rerun that hasn't started yet", async () => {
    const failed = { state: "MERGED" as const, mergedAt: NOW - 600_000, deploy: "FAILED" as const };
    const ports = fakePorts({ snapshots: [aSnapshot("failed", failed)] });

    const result = await tick(watchStarted({ lastSnapshot: "failed", lastFacts: aFacts(failed), awaiting: { trigger: "rerun", since: NOW - 60_000 } }), ports, settings());

    expect(result.stop).toBe(false);
    expect(ports.notifications).toEqual([]);
  });
});

describe("tick: the commit a branch update creates", () => {
  const before = aFacts({ review: "REVIEW_REQUIRED", headSha: "aaaaaaa1" });
  const after = { review: "REVIEW_REQUIRED" as const, headSha: "bbbbbbb2", ...moving };

  test("is expected, not news", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("updated", after)] });

    const result = await tick(watchStarted({ lastSnapshot: "before", lastFacts: before, expectedCommitSince: NOW - 60_000 }), ports, settings());

    expect(ports.notifications).toEqual([]);
    expect(result.watch.expectedCommitSince).toBeUndefined();
  });

  test("only the first new commit is expected", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("updated", after), aSnapshot("pushed", { ...after, headSha: "ccccccc3" })] });

    const first = await tick(watchStarted({ lastSnapshot: "before", lastFacts: before, expectedCommitSince: NOW - 60_000 }), ports, settings());
    await tick(first.watch, ports, settings());

    expect(ports.notifications).toEqual([{ sessionID: "ses_parent", text: expect.stringContaining("new commit ccccccc"), wake: false }]);
  });

  test("a new commit long after the update is news again", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("updated", after)] });

    await tick(watchStarted({ lastSnapshot: "before", lastFacts: before, expectedCommitSince: NOW - 11 * 60_000 }), ports, settings());

    expect(ports.notifications).toEqual([{ sessionID: "ses_parent", text: expect.stringContaining("new commit bbbbbbb"), wake: false }]);
  });

  test("a branch update on a watched PR expects its commit", () => {
    expect(awaitTrigger(aWatch(), "update-branch", 5_000).expectedCommitSince).toBe(5_000);
    expect(awaitTrigger(aWatch(), "rerun", 5_000).expectedCommitSince).toBeUndefined();
  });
});

describe("tick: waiting", () => {
  test("keeps waiting for review well past 30 minutes, polling every 30 seconds", async () => {
    const facts = aFacts({ review: "REVIEW_REQUIRED" });
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", { review: "REVIEW_REQUIRED" })] });

    const result = await tick(
      watchStarted({ startedAt: NOW - 5 * 3_600_000, phase: "review", phaseSince: NOW - 5 * 3_600_000, lastSnapshot: "waiting", lastFacts: facts }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(false);
    expect(result.delayMs).toBe(30_000);
    expect(ports.notifications).toEqual([]);
  });

  test("reminds once a day while waiting for review", async () => {
    const facts = aFacts({ review: "REVIEW_REQUIRED" });
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", { review: "REVIEW_REQUIRED" }), aSnapshot("waiting", { review: "REVIEW_REQUIRED" })] });
    const watch = watchStarted({ phase: "review", phaseSince: NOW - 25 * 3_600_000, lastSnapshot: "waiting", lastFacts: facts });

    const first = await tick(watch, ports, settings());
    const second = await tick(first.watch, ports, settings());

    expect(second.stop).toBe(false);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("still waiting for code review");
    expect(ports.notifications[0]!.wake).toBe(false);
  });

  test("a watch that starts while a deploy waits for approval says so once", async () => {
    const waiting = { state: "MERGED" as const, mergedAt: NOW - 60_000, deploy: "WAITING" as const, waitingJobs: ["core / Bicep Deploy"] };
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", waiting), aSnapshot("waiting", waiting)] });
    const watch = watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts(waiting) });

    const first = await tick(watch, ports, settings());
    const second = await tick(first.watch, ports, settings());

    expect(second.stop).toBe(false);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("run approval needed (deploy): core / Bicep Deploy");
  });

  test("checks waiting at an environment gate are reported, and don't end after 30 minutes", async () => {
    const gate = { checks: "PENDING" as const, review: "REVIEW_REQUIRED" as const, waitingChecks: ["CORE terraform / Plan"] };
    const ports = fakePorts({ snapshots: [aSnapshot("gate", gate), aSnapshot("gate", gate)] });
    const watch = watchStarted({ phase: "approval", phaseSince: NOW - 2 * 3_600_000, lastSnapshot: "gate", lastFacts: aFacts(gate) });

    const first = await tick(watch, ports, settings());
    const second = await tick(first.watch, ports, settings());

    expect(second.stop).toBe(false);
    expect(second.delayMs).toBe(30_000);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("run approval needed (checks): CORE terraform / Plan");
  });

  test("reports again when the approval is given and a new gate follows", async () => {
    const first = { checks: "PENDING" as const, waitingChecks: ["CORE / Plan"] };
    const none = { checks: "PENDING" as const };
    const second = { checks: "PENDING" as const, waitingChecks: ["PROD / Plan"] };
    const ports = fakePorts({ snapshots: [aSnapshot("gate", first), aSnapshot("gate", none), aSnapshot("gate", second)] });
    let watch = watchStarted({ lastSnapshot: "gate", lastFacts: aFacts(first) });

    for (let i = 0; i < 3; i++) watch = (await tick(watch, ports, settings())).watch;

    expect(ports.notifications.map((n) => n.text)).toEqual([
      expect.stringContaining("run approval needed (checks): CORE / Plan"),
      expect.stringContaining("run approval given; now checks running"),
      expect.stringContaining("run approval needed (checks): PROD / Plan"),
    ]);
  });

  test("a pipeline phase past 30 minutes is said once, waking the agent, and the watch goes on", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 31 * 60_000, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(false);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("checks still running after 30 minutes");
    expect(ports.notifications[0]!.text).toContain("still watching");
    expect(ports.notifications[0]!.wake).toBe(true);

    const again = fakePorts({ snapshots: [aSnapshot("running", moving)] });
    await tick(result.watch, again, settings());
    expect(again.notifications).toEqual([]);
  });

  test("measures the time limit from when the phase began, not from the start of the watch", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("deploying", { state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING" })] });
    const watch = watchStarted({ startedAt: NOW - 2 * 3_600_000, phase: "review", phaseSince: NOW - 2 * 3_600_000, lastSnapshot: "waiting", lastFacts: aFacts({ review: "REVIEW_REQUIRED", autoMerge: true }) });

    const result = await tick(watch, ports, settings());

    expect(result.stop).toBe(false);
    expect(result.watch).toMatchObject({ phase: "deploy", phaseSince: NOW });
  });

  test("reports a stuck deploy job once and keeps watching", async () => {
    const stuck = { state: "MERGED" as const, mergedAt: NOW - 3_600_000, deploy: "WAITING" as const, waitingJobs: ["DEPLOY - Prod"], unfinishedJobs: [{ name: "DEPLOY - Prod", since: NOW - 50 * 60_000 }] };
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", stuck), aSnapshot("waiting", stuck)] });
    const watch = watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts(stuck), approvalReported: "deploy:DEPLOY - Prod" });

    const first = await tick(watch, ports, settings());
    const second = await tick(first.watch, ports, settings());

    expect(first.stop).toBe(false);
    expect(second.stop).toBe(false);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("looks stuck: DEPLOY - Prod (50 min)");
  });
});

describe("tick: the model only for other changes", () => {
  test("asks the model when the text changed without a fixed event", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("checks: 3 of 5 done", moving)], verdicts: ['{"verdict":"wait"}'] });

    await tick(watchStarted({ lastSnapshot: "checks: 2 of 5 done", lastFacts: aFacts(moving) }), ports, settings());

    expect(ports.judged).toHaveLength(1);
    expect(ports.notifications).toEqual([]);
  });

  test("passes on what the model flags, without stopping on its done/failed", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("deploy job skipped", moving)], verdicts: ['{"verdict":"failed","reason":"prod deploy job was skipped"}'] });

    const result = await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts(moving) }), ports, settings());

    expect(result.stop).toBe(false);
    expect(ports.notifications[0]!.text).toContain("prod deploy job was skipped");
  });

  test("a model error is retried quietly on the next check (plan 11)", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("checks: 3 of 5 done", moving)] });
    ports.judgeError = new Error("ECONNRESET");

    const result = await tick(watchStarted({ lastSnapshot: "checks: 2 of 5 done", lastFacts: aFacts(moving) }), ports, settings());

    expect(ports.notifications).toEqual([]);
    expect(result.watch.lastSnapshot).toBe("checks: 2 of 5 done");
    expect(result.watch.judgeFailingSince).toBe(NOW);
  });

  test("reported once when judging has failed for 30 minutes, then quiet until it works again", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("x", moving), aSnapshot("y", moving)] });
    ports.judgeError = new Error("ECONNRESET");
    const failing = watchStarted({ lastSnapshot: "before", lastFacts: aFacts(moving), judgeFailingSince: NOW - 31 * 60_000 });

    const result = await tick(failing, ports, settings());
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("could not judge changes for 31 minutes (ECONNRESET)");

    await tick(result.watch, ports, settings());
    expect(ports.notifications).toHaveLength(1);

    ports.judgeError = undefined;
    const recovered = await tick({ ...result.watch, lastSnapshot: "z" }, fakePorts({ snapshots: [aSnapshot("w", moving)], verdicts: ['{"verdict":"wait"}'] }), settings());
    expect(recovered.watch.judgeFailingSince).toBeUndefined();
  });

  test("does not ask the model when nothing changed", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("same", moving)] });

    await tick(watchStarted({ lastSnapshot: "same", lastFacts: aFacts(moving) }), ports, settings());

    expect(ports.judged).toEqual([]);
  });

  test("uses the guarded model and the pinned directory", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("changed", moving)], verdicts: ['{"verdict":"wait"}'] });

    await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts(moving) }), ports, settings({ preferences: ["haiku"] }));

    expect(ports.judged[0]).toMatchObject({ model: { providerID: "github-copilot", id: "claude-haiku" }, directory: "/repo" });
  });

  test("stops without calling a model when the provider guard refuses, and says how to resume", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("changed", moving)] });
    ports.sessionView = aSession("anthropic", "claude-opus");

    const result = await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts(moving) }), ports, settings());

    expect(result.stop).toBe(true);
    expect(ports.judged).toEqual([]);
    expect(ports.notifications[0]!.text).toContain("switched provider");
    expect(ports.notifications[0]!.text).toContain("call watch_pr again to resume");
  });

  test("asks the model with both the previous and the new state", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("state: MERGED", moving)], verdicts: ['{"verdict":"wait"}'] });

    await tick(watchStarted({ lastSnapshot: "state: OPEN", lastFacts: aFacts(moving) }), ports, settings());

    expect(ports.judged[0]!.prompt).toContain("state: OPEN");
    expect(ports.judged[0]!.prompt).toContain("state: MERGED");
  });
});

describe("tick: bookkeeping", () => {
  test("records the new state and when it last changed", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("changed", { review: "APPROVED", checks: "PENDING" })], verdicts: [] });

    const result = await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts({ review: "REVIEW_REQUIRED", checks: "PENDING" }) }), ports, settings());

    expect(result.watch).toMatchObject({ lastSnapshot: "changed", lastChangeAt: NOW, lastCheckedAt: NOW, lastFacts: { review: "APPROVED" } });
  });

  test("keeps watching when the PR could not be read", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("Could not read the PR: timeout")] });

    const result = await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts(moving) }), ports, settings());

    expect(result.stop).toBe(false);
    expect(result.watch.lastFacts).toEqual(aFacts(moving));
    expect(ports.judged).toEqual([]);
  });

  test("stops without notifying when the session no longer exists", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("merged", moving)] });
    ports.sessionError = new Error("session not found");

    const result = await tick(watchStarted(), ports, settings());

    expect(result.stop).toBe(true);
    expect(ports.notifications).toEqual([]);
  });

  test("still stops when the stop message cannot be delivered", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("closed", { state: "CLOSED" })] });
    ports.notifyError = new Error("session is gone");

    const result = await tick(watchStarted({ lastSnapshot: "open", lastFacts: aFacts(moving) }), ports, settings());

    expect(result.stop).toBe(true);
  });
});

describe("tick: failing checks when the watch starts", () => {
  const failing = { checks: "FAIL" as const, failingChecks: ["Trivy"] };
  const awaiting = { trigger: "failed-checks" as const, since: NOW - 60_000 };

  test("keeps watching the old failure while the new run hasn't started", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("failing", failing)] });

    const result = await tick(watchStarted({ lastSnapshot: "failing", lastFacts: aFacts(failing), awaiting }), ports, settings());

    expect(result.stop).toBe(false);
    expect(result.delayMs).toBe(30_000);
    expect(ports.notifications).toEqual([]);
  });

  test("stops waiting once the new run starts; if that run fails too, it says so and goes on watching", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", { checks: "PENDING" }), aSnapshot("failing again", failing)] });

    const running = await tick(watchStarted({ lastSnapshot: "failing", lastFacts: aFacts(failing), awaiting }), ports, settings());
    const failedAgain = await tick(running.watch, ports, settings());

    expect(running.stop).toBe(false);
    expect(running.watch.awaiting).toBeUndefined();
    expect(failedAgain.stop).toBe(false);
    expect(ports.notifications.at(-1)!.text).toContain("checks failed: Trivy");
  });
});

describe("tick: re-checking before sending", () => {
  test("a watch replaced by a newer one sends nothing and stops", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("ready", {})] });
    ports.live = { owned: false };

    const result = await tick(watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }), readySince: NOW - 30_000 }), ports, settings());

    expect(result.stop).toBe(true);
    expect(ports.notifications).toEqual([]);
  });

  test("drops a message the live state no longer supports", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("ready", {})] });
    ports.live = { owned: true, facts: aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "RUNNING" }) };

    const result = await tick(watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) }), ports, settings());

    expect(ports.notifications).toEqual([]);
    expect(result.stop).toBe(false);
  });
});

describe("tick: facts and a suggestion at the end", () => {
  test("names the author and suggests, leaving the decision to the agent", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("behind", { branch: "BEHIND", author: "app/renovate", authorIsBot: true })] });
    ports.botAdvice = "tick the rebase checkbox in the PR description";

    await tick(watchStarted({ lastSnapshot: "ok", lastFacts: aFacts({ checks: "PENDING", author: "app/renovate", authorIsBot: true }) }), ports, settings());

    expect(ports.notifications[0]!.text).toContain("behind main (opened by app/renovate)");
    expect(ports.notifications[0]!.text).toContain("suggestion (read from the bot's PR description, verify before acting): tick the rebase checkbox in the PR description");
  });

  test("a flaky failure seen before is not offered another rerun", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("failed", { checks: "FAIL", failingChecks: ["Build"] })] });
    ports.diagnosis = { kind: "flaky", cause: "runner lost" };
    ports.failuresBefore = 1;

    await tick(watchStarted({ lastSnapshot: "running", lastFacts: aFacts({ checks: "PENDING" }) }), ports, settings());

    expect(ports.notifications[0]!.text).toContain("failed the same way before: runner lost");
    expect(ports.countedFailures).toEqual(["checks:Build"]);
  });
});

describe("tick: time limits from history", () => {
  test("a build phase gets its limit from the workflow's history when it starts", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });
    ports.limit = { limitMs: 18 * 60_000, basis: "normally under 12 min (p90 of last 20 runs)" };

    const result = await tick(watchStarted({ lastSnapshot: "review", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) }), ports, settings());

    expect(result.watch.phaseLimit).toEqual(ports.limit);
  });

  test("past the learned limit it says so, with the basis and the model's stall check, and goes on", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });
    ports.stall = "looks stuck: no step finished in 20 min";
    const limit = { limitMs: 18 * 60_000, basis: "normally under 12 min (p90 of last 20 runs)" };

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 19 * 60_000, phaseLimit: limit, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(false);
    const text = ports.notifications[0]!.text;
    expect(text).toContain("checks still running after 18 minutes");
    expect(text).toContain("normally under 12 min");
    expect(text).toContain("looks stuck: no step finished in 20 min");
  });

  test("past the limit but progressing: keeps watching quietly, with the limit doubled once (platform#2417)", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });
    ports.stall = "looks slow but progressing: apply still advancing";
    const limit = { limitMs: 18 * 60_000, basis: "normally under 12 min (p90 of last 20 runs)" };

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 19 * 60_000, phaseLimit: limit, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(false);
    expect(ports.notifications).toEqual([]);
    expect(result.watch.phaseLimit).toEqual({ limitMs: 36 * 60_000, basis: limit.basis, extended: true });
  });

  test("past the doubled limit it says so, even if still progressing, and goes on", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });
    ports.stall = "looks slow but progressing: apply still advancing";
    const limit = { limitMs: 36 * 60_000, basis: "normally under 12 min (p90 of last 20 runs)", extended: true };

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 37 * 60_000, phaseLimit: limit, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(false);
    expect(ports.notifications[0]!.text).toContain("looks slow but progressing");
  });

  test("without history the default applies", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 20 * 60_000, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(false);
  });
});

describe("tick: auto-merge changes", () => {
  test("names who disabled auto-merge, without guessing why", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("off", { autoMerge: false, checks: "PENDING" })] });
    ports.autoMergeActor = "octocat";

    await tick(watchStarted({ lastSnapshot: "on", lastFacts: aFacts({ autoMerge: true, checks: "PENDING" }) }), ports, settings());

    expect(ports.notifications[0]!.text).toContain("auto-merge disabled by octocat");
    expect(ports.judged).toEqual([]);
  });
});

describe("tick: a closed bot PR with a replacement", () => {
  test("names the replacement and moves the watch to it", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("closed", { state: "CLOSED", author: "app/renovate", authorIsBot: true })] });
    ports.replacement = 41;

    const result = await tick(watchStarted({ lastSnapshot: "open", lastFacts: aFacts({ checks: "PENDING", author: "app/renovate", authorIsBot: true }) }), ports, settings());

    expect(result.stop).toBe(true);
    expect(result.follow).toBe(41);
    expect(ports.notifications[0]!.text).toContain("superseded by #41, now watching it");
  });

  test("doesn't look for a replacement for people's PRs", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("closed", { state: "CLOSED", author: "octocat" })] });
    ports.replacement = 41;

    const result = await tick(watchStarted({ lastSnapshot: "open", lastFacts: aFacts({ checks: "PENDING", author: "octocat" }) }), ports, settings());

    expect(result.follow).toBeUndefined();
  });
});

describe("judgePrompt", () => {
  test("tells the judge that only runs triggered by the merge are the PR's own outcome", () => {
    const prompt = judgePrompt(aWatch(), "state: MERGED");

    expect(prompt).toContain("triggered by the merge");
    expect(prompt).toContain("[push]");
    expect(prompt).toMatch(/\[schedule\].*not the PR's outcome/s);
  });

  test("only asks whether to tell the developer, since fixed events are reported separately", () => {
    const prompt = judgePrompt(aWatch(), "state: OPEN");

    expect(prompt).toContain('"notify" | "wait"');
    expect(prompt).toContain("already reported");
  });

  test("tells the model skipped steps are expected and never worth reporting", () => {
    const prompt = judgePrompt(aWatch(), "state: MERGED");

    expect(prompt).toContain("Skipped jobs and checks are expected");
    expect(prompt).not.toMatch(/notify:.*skipped/i);
  });
});

describe("awaitTrigger", () => {
  test("a branch update on a PR already watched ignores the state it replaces, like a new watch would", () => {
    const watch = aWatch();

    expect(awaitTrigger(watch, "update-branch", 5_000).awaiting).toEqual({ trigger: "update-branch", since: 5_000 });
  });

  test("a newer trigger replaces an older one", () => {
    const watch = aWatch({ awaiting: { trigger: "failed-checks", since: 1_000 } });

    expect(awaitTrigger(watch, "update-branch", 5_000).awaiting).toEqual({ trigger: "update-branch", since: 5_000 });
  });

  test("tells the model to state facts, never intent", () => {
    expect(judgePrompt(aWatch(), "x")).toContain("Never guess what anyone intended or wanted");
  });
});

describe("the judge prompt (plan 25, infra#775)", () => {
  test("tells the model jobs appear as a run reaches them and a missing job isn't news", () => {
    expect(judgePrompt(watchStarted({ lastSnapshot: "a" }), "b")).toContain("never report jobs as disappearing");
  });
});

describe("debug log (diagnosing watches)", () => {
  test("a check logs its step, events, end and the message it sent", async () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const ports = fakePorts({ snapshots: [aSnapshot("failed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "FAILED" })] });
    ports.debug = (event, fields = {}) => void lines.push({ event, fields });

    await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" }) }), ports, settings());

    expect(lines.find((l) => l.event === "check")?.fields).toMatchObject({ id: "acme/api#42", step: "DEPLOY_FAILED", changed: true });
    expect(lines.find((l) => l.event === "notify")?.fields.text).toContain("the merge pipeline failed");
    expect(lines.find((l) => l.event === "result")?.fields).toMatchObject({ stop: false });
  });

  test("a model error is logged even when it isn't reported", async () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const ports = fakePorts({ snapshots: [aSnapshot("checks: 3 of 5 done", moving)] });
    ports.judgeError = new Error("ECONNRESET");
    ports.debug = (event, fields = {}) => void lines.push({ event, fields });

    await tick(watchStarted({ lastSnapshot: "checks: 2 of 5 done", lastFacts: aFacts(moving) }), ports, settings());

    expect(lines.find((l) => l.event === "judge")?.fields).toMatchObject({ error: expect.anything() });
  });
});

describe("runs attached to a PR watch", () => {
  test("a finished run leaves the watch, which keeps going", async () => {
    const done = { run: 9, workflow: "MAIN", url: "u", state: "SUCCEEDED" as const };
    const ports = fakePorts({ snapshots: [aSnapshot("x", { ...moving, attachedRuns: [done] })] });
    const result = await tick(watchStarted({ lastSnapshot: "x", lastFacts: aFacts({ ...moving, attachedRuns: [{ ...done, state: "RUNNING" }] }), runs: [9] }), ports, settings());
    expect(result.stop).toBe(false);
    expect(result.watch.runs).toBeUndefined();
    expect(ports.notifications[0]!.text).toContain("run MAIN succeeded");
  });
});

describe("a watch taken over by another folder's plugin instance (orphan takeover)", () => {
  test("keeps going on facts and doesn't stop because the guard refuses a model there", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("checks: 3 of 5 done", moving)], verdicts: ['{"verdict":"wait"}'] });
    const taken = watchStarted({ lastSnapshot: "checks: 2 of 5 done", lastFacts: aFacts(moving), pinned: { providerID: "github-copilot", directory: "/elsewhere" } });

    const result = await tick(taken, ports, settings());

    expect(result.stop).toBe(false);
    expect(ports.judged).toEqual([]);
    expect(ports.notifications).toEqual([]);
  });
});

describe("every step change by rule, progress as the track (acme/admin#41)", () => {
  const running = { checks: "PENDING" as const, review: "REVIEW_REQUIRED" as const, checksProgress: { done: 3, total: 5, current: "Scan" } };
  const passed = { checks: "PASS" as const, review: "REVIEW_REQUIRED" as const };

  test("checks that finish and pass are reported, without asking the model", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("all passed", passed)] });
    const result = await tick(watchStarted({ lastSnapshot: "running", lastFacts: aFacts(running) }), ports, settings());
    expect(result.stop).toBe(false);
    expect(ports.notifications[0]!.text).toContain("checks passed; now waiting for code review");
    expect(ports.judged).toEqual([]);
  });

  test("progress within a step is said as the track, as information, and the model still looks for the unexpected", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("4 of 5", { ...running, checksProgress: { done: 4, total: 5, current: "Build" } })], verdicts: ['{"verdict":"wait"}'] });
    const result = await tick(watchStarted({ lastSnapshot: "3 of 5", lastFacts: aFacts(running), lastTrack: "old", lastTrackAt: NOW - 120_000, lastTrackVersion: TRACK_VERSION }), ports, settings());
    expect(ports.notifications).toEqual([{ sessionID: "ses_parent", text: expect.stringContaining("progress: Checks … 4/5 · Build · Review · Merge · Deploy"), wake: false }]);
    expect(ports.judged).toHaveLength(1);
    expect(result.watch.lastTrack).toBe("Checks running 4/5 · Build · Review upcoming · Merge upcoming · Deploy upcoming");
  });

  test("a new track format is noted silently, not sent as progress", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("3 of 5", running)], verdicts: ['{"verdict":"wait"}'] });
    const result = await tick(watchStarted({ lastSnapshot: "3 of 5", lastFacts: aFacts(running), lastTrack: "PR ✓ · Checks … 3/5 · Scan", lastTrackAt: NOW - 120_000, lastTrackVersion: 0 }), ports, settings());
    expect(ports.notifications).toEqual([]);
    expect(result.watch.lastTrack).toBe("Checks running 3/5 · Scan · Review upcoming · Merge upcoming · Deploy upcoming");
  });

  test("at most one progress message a minute; the next check says the latest", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("4 of 5", { ...running, checksProgress: { done: 4, total: 5, current: "Build" } })], verdicts: ['{"verdict":"wait"}'] });
    const result = await tick(watchStarted({ lastSnapshot: "3 of 5", lastFacts: aFacts(running), lastTrack: "old", lastTrackAt: NOW - 30_000, lastTrackVersion: TRACK_VERSION }), ports, settings());
    expect(ports.notifications).toEqual([]);
    expect(result.watch.lastTrack).toBe("old");
  });

  test("the first check only notes the track, so starting a watch says nothing extra", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("3 of 5", running)], verdicts: ['{"verdict":"wait"}'] });
    const result = await tick(watchStarted({ lastSnapshot: "3 of 5", lastFacts: aFacts(running) }), ports, settings());
    expect(ports.notifications).toEqual([]);
    expect(result.watch.lastTrack).toBe("Checks running 3/5 · Scan · Review upcoming · Merge upcoming · Deploy upcoming");
  });
});

describe("what wakes the agent: only what it can act on", () => {
  test("something to fix wakes it", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("failing", { checks: "FAIL", failingChecks: ["Build"] })] });
    await tick(watchStarted({ lastSnapshot: "running", lastFacts: aFacts({ checks: "PENDING" }) }), ports, settings());
    expect(ports.notifications.map((n) => n.wake)).toEqual([true]);
  });

  test("a change of step, or a person's turn, only informs; ready to merge goes to the agent", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", { review: "REVIEW_REQUIRED" }), aSnapshot("ready", {})] });
    const first = await tick(watchStarted({ lastSnapshot: "running", lastFacts: aFacts({ checks: "PENDING", review: "REVIEW_REQUIRED" }) }), ports, settings());
    await tick(first.watch, ports, settings());
    expect(ports.notifications.map((n) => n.wake)).toEqual([false, true]);
  });

  test("the end wakes it", async () => {
    const before = aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" });
    const ports = fakePorts({ snapshots: [aSnapshot("deployed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "SUCCEEDED" })] });
    await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: before }), ports, settings());
    expect(ports.notifications.map((n) => n.wake)).toEqual([true]);
  });
});

describe("a new problem is said once, not also as the plain event", () => {
  test("conflicts", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("conflict", { branch: "CONFLICT", author: "octocat" })] });
    await tick(watchStarted({ lastSnapshot: "ok", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) }), ports, settings());
    const text = ports.notifications[0]!.text;
    expect(text).not.toContain("conflicts with main; conflicts with main");
    expect(text).toContain("conflicts with main (opened by octocat)");
  });
});

describe("what wakes the agent", () => {
  test("a person's turn informs without waking the agent", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("review", { review: "REVIEW_REQUIRED" })] });
    await tick(watchStarted({ lastSnapshot: "running", lastFacts: aFacts({ checks: "PENDING", review: "REVIEW_REQUIRED" }) }), ports, settings());
    expect(ports.notifications[0]!.wake).toBe(false);
  });
});

describe("the daily review reminder says who it waits for", () => {
  test("with the requested reviewers", async () => {
    const waiting = { review: "REVIEW_REQUIRED" as const, reviewers: ["platform-approvers"] };
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", waiting)] });
    await tick(watchStarted({ phase: "review", phaseSince: NOW - 26 * 3_600_000, lastSnapshot: "waiting", lastFacts: aFacts(waiting) }), ports, settings());
    expect(ports.notifications.map((n) => n.text).join()).toContain("still waiting for code review from platform-approvers");
  });
});

describe("new comments from collaborators are said, without their text", () => {
  test("after the first read; a review comment wakes the agent", async () => {
    const before = aFacts({ review: "REVIEW_REQUIRED", commentIds: ["c1"], comments: [{ id: "c1", author: "anna", url: "u1" }] });
    const after = { review: "REVIEW_REQUIRED" as const, commentIds: ["c1", "t1"], comments: [{ id: "c1", author: "anna", url: "u1" }, { id: "t1", author: "bob", path: "src/a.ts", url: "u2" }] };
    const ports = fakePorts({ snapshots: [aSnapshot("commented", after)] });
    await tick(watchStarted({ lastSnapshot: "commented", lastFacts: before }), ports, settings());
    expect(ports.notifications[0]!.text).toContain("new review comment by bob on src/a.ts (u2)");
    expect(ports.notifications[0]!.wake).toBe(true);
  });

  test("a failed read keeps the last one, so the next read doesn't report old comments as new", async () => {
    const before = aFacts({ review: "REVIEW_REQUIRED", commentIds: ["c1"], comments: [{ id: "c1", author: "anna", url: "u1" }] });
    const ports = fakePorts({ snapshots: [aSnapshot("same", { review: "REVIEW_REQUIRED" })], verdicts: ['{"verdict":"wait"}'] });
    const result = await tick(watchStarted({ lastSnapshot: "same", lastFacts: before }), ports, settings());
    expect(result.watch.lastFacts?.commentIds).toEqual(["c1"]);
    expect(ports.notifications).toEqual([]);
  });
});

describe("a watch started from the quick read", () => {
  test("its first full check is the baseline: noted, not reported", async () => {
    const quick = aFacts({ review: "REVIEW_REQUIRED" });
    const full = { review: "REVIEW_REQUIRED" as const, required: ["Build"], unresolvedThreads: 2 };
    const ports = fakePorts({ snapshots: [aSnapshot("full", full)] });
    const result = await tick(watchStarted({ lastSnapshot: "quick", lastFacts: quick, provisional: true }), ports, settings());
    expect(ports.notifications).toEqual([]);
    expect(result.watch.provisional).toBeUndefined();
    expect(result.watch.lastSnapshot).toBe("full");
  });
});

describe("a watch from before a change in how the state is read", () => {
  test("takes its next check as the baseline: noted, not reported", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("without scanners", { review: "REVIEW_REQUIRED" })] });
    const result = await tick(watchStarted({ lastSnapshot: "with scanners", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }), snapshotVersion: SNAPSHOT_VERSION - 1 }), ports, settings());
    expect(ports.notifications).toEqual([]);
    expect(result.watch.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(result.watch.lastSnapshot).toBe("without scanners");
  });

  test("the current version compares as usual", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("changed", { review: "REVIEW_REQUIRED" })], verdicts: ['{"verdict":"notify","reason":"x"}'] });
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }), snapshotVersion: SNAPSHOT_VERSION }), ports, settings());
    expect(ports.notifications.length).toBe(1);
  });
});

describe("a ready PR waiting for someone else's deploy on its base branch", () => {
  const ready = { review: "APPROVED" as const };
  const waiting = { review: "APPROVED" as const, deployingOnBase: ["MAIN - Deployment pipeline"] };

  test("going into the wait and out of it again says nothing", async () => {
    const into = fakePorts({ snapshots: [aSnapshot("waiting", waiting)], verdicts: ['{"verdict":"wait"}'] });
    const first = await tick(watchStarted({ phase: "ready", lastSnapshot: "ready", lastFacts: aFacts(ready) }), into, settings());
    expect(into.notifications).toEqual([]);
    expect(first.watch.readyBeforeWait).toBe(true);

    const out = fakePorts({ snapshots: [aSnapshot("ready", ready)], verdicts: ['{"verdict":"wait"}'] });
    const second = await tick(first.watch, out, settings());
    expect(out.notifications).toEqual([]);
    expect(second.watch.readyBeforeWait).toBeUndefined();
  });

  test("a PR that wasn't ready before the wait is said to be ready after it", async () => {
    const out = fakePorts({ snapshots: [aSnapshot("ready", ready)], verdicts: ['{"verdict":"wait"}'] });
    await tick(watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts(waiting) }), out, settings());
    expect(out.notifications[0]!.text).toContain("ready to merge");
  });
});

describe("progress is a stage changing state, or a running stage moving on", () => {
  test("a static detail changing (the expected deploy, reviewers) is not progress", async () => {
    const before = aFacts({ review: "REVIEW_REQUIRED", expectedDeploy: { jobs: ["A", "B", "C"], approval: [] } });
    const after = { review: "REVIEW_REQUIRED" as const, expectedDeploy: { jobs: ["A", "B"], approval: [] }, reviewers: ["approvers"] };
    const ports = fakePorts({ snapshots: [aSnapshot("after", after)], verdicts: ['{"verdict":"wait"}'] });
    const start = watchStarted({ lastSnapshot: "before", lastFacts: before });
    const noted = await tick(start, fakePorts({ snapshots: [aSnapshot("before", { review: "REVIEW_REQUIRED", expectedDeploy: { jobs: ["A", "B", "C"], approval: [] } })] }), settings());
    await tick({ ...noted.watch, lastTrackAt: NOW - 120_000 }, ports, settings());
    expect(ports.notifications.filter((n) => n.text.startsWith("acme/api#42: progress"))).toEqual([]);
  });

  test("a running stage moving on is", async () => {
    const running = { checks: "PENDING" as const, checksProgress: { done: 3, total: 5 } };
    const ports = fakePorts({ snapshots: [aSnapshot("4 of 5", { ...running, checksProgress: { done: 4, total: 5 } })], verdicts: ['{"verdict":"wait"}'] });
    const noted = await tick(watchStarted({ lastSnapshot: "3 of 5", lastFacts: aFacts(running) }), fakePorts({ snapshots: [aSnapshot("3 of 5", running)] }), settings());
    await tick({ ...noted.watch, lastTrackAt: NOW - 120_000 }, ports, settings());
    expect(ports.notifications.map((n) => n.text).join()).toContain("progress: Checks … 4/5");
  });
});

describe("how a watch ends", () => {
  test("deployed: said once, not again as the reason", async () => {
    const deploying = aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" });
    const ports = fakePorts({ snapshots: [aSnapshot("deployed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "SUCCEEDED" })] });
    await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: deploying }), ports, settings());
    const text = ports.notifications[0]!.text;
    expect(text.match(/deployed \(/g)?.length).toBe(1);
    expect(text).toContain("watch stopped");
  });

  test("closed by the gh user: informs, doesn't wake; closed by someone else wakes", async () => {
    const open = aFacts({ review: "REVIEW_REQUIRED" });
    const mine = fakePorts({ snapshots: [aSnapshot("closed", { state: "CLOSED", closedByViewer: true })] });
    await tick(watchStarted({ lastSnapshot: "open", lastFacts: open }), mine, settings());
    expect(mine.notifications[0]!.wake).toBe(false);
    const theirs = fakePorts({ snapshots: [aSnapshot("closed", { state: "CLOSED" })] });
    await tick(watchStarted({ lastSnapshot: "open", lastFacts: open }), theirs, settings());
    expect(theirs.notifications[0]!.wake).toBe(true);
  });
});

describe("the reminder's hours are working hours", () => {
  test("a wait from Thursday 11:00 is 46 h on Monday at 09:00, not 94", async () => {
    const thursday = new Date(2026, 9, 15, 11, 0).getTime();
    const monday = new Date(2026, 9, 19, 9, 0).getTime();
    const waiting = { review: "REVIEW_REQUIRED" as const };
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", waiting)] });
    ports.time = monday;
    await tick(watchStarted({ phase: "review", phaseSince: thursday, lastReminderAt: thursday, lastSnapshot: "waiting", lastFacts: aFacts(waiting) }), ports, settings());
    expect(ports.notifications[0]!.text).toContain("still waiting for code review (46 h)");
  });
});

describe("new review comments wake the agent; conversation comments only inform", () => {
  const before = aFacts({ review: "REVIEW_REQUIRED", commentIds: [], comments: [] });
  test("Copilot's review comments wake it", async () => {
    const after = { review: "REVIEW_REQUIRED" as const, commentIds: ["t1"], comments: [{ id: "t1", author: "copilot-pull-request-reviewer", path: "a.ts", url: "u1", bot: true as const }] };
    const ports = fakePorts({ snapshots: [aSnapshot("reviewed", after)] });
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: before }), ports, settings());
    expect(ports.notifications[0]!.text).toContain("copilot-pull-request-reviewer left 1 review comment (u1)");
    expect(ports.notifications[0]!.wake).toBe(true);
  });
  test("a conversation comment does too", async () => {
    const after = { review: "REVIEW_REQUIRED" as const, commentIds: ["c1"], comments: [{ id: "c1", author: "anna", url: "u1" }] };
    const ports = fakePorts({ snapshots: [aSnapshot("commented", after)] });
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: before }), ports, settings());
    expect(ports.notifications[0]!.wake).toBe(true);
  });
});

describe("new comments are read by the light model and the user asked what to do", () => {
  const before = aFacts({ review: "REVIEW_REQUIRED", commentIds: ["c0"], comments: [] });
  const after = { review: "REVIEW_REQUIRED" as const, commentIds: ["c0", "t1"], comments: [{ id: "t1", author: "bob", path: "a.ts", url: "u1" }] };

  test("off by default: no model reads the comments, who and where only", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("commented", after)] });
    ports.analysed = ["should not be used"];
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: before }), ports, settings());
    expect(ports.analysedFor).toEqual([]);
    expect(ports.notifications[0]!.text).toContain("new review comment by bob on a.ts (u1)");
  });

  test("turned on: the model's plain-language line replaces who-and-where, the agent is woken and told to ask", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("commented", after)] });
    ports.analysed = ["new review comment by bob on a.ts:3, change requested: wants a null check (u1)"];
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: before }), ports, settings({ analyseComments: true }));
    expect(ports.analysedFor).toEqual([["t1"]]);
    const text = ports.notifications[0]!.text;
    expect(text).toContain("change requested: wants a null check (u1)");
    expect(text).not.toContain("new review comment by bob on a.ts (u1)");
    expect(text).toContain("ask the user");
    expect(ports.notifications[0]!.wake).toBe(true);
  });

  test("turned on, without a model answer: who and where, as before", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("commented", after)] });
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: before }), ports, settings({ analyseComments: true }));
    expect(ports.notifications[0]!.text).toContain("new review comment by bob on a.ts (u1)");
  });
});

describe("unresolved threads already there are said once", () => {
  const open = { id: "t1", author: "copilot-pull-request-reviewer", path: "a.ts", url: "u1", bot: true as const, openThread: true as const };
  const facts = { review: "REVIEW_REQUIRED" as const, unresolvedThreads: 1, commentIds: ["t1"], comments: [open] };

  test("by a watch that hasn't said them yet, waking the agent; then not again", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("same", facts), aSnapshot("same", facts)], verdicts: ['{"verdict":"wait"}'] });
    const first = await tick(watchStarted({ lastSnapshot: "same", lastFacts: aFacts(facts) }), ports, settings());
    expect(ports.notifications[0]!.text).toContain("copilot-pull-request-reviewer has 1 unresolved review comment (u1)");
    expect(ports.notifications[0]!.wake).toBe(true);
    await tick(first.watch, ports, settings());
    expect(ports.notifications.length).toBe(1);
  });
});

describe("ready to merge goes to the agent, saying whether the user is needed", () => {
  const approving = aFacts({ review: "REVIEW_REQUIRED" });
  const ready = (extra: Record<string, unknown>) => ({ review: "APPROVED" as const, ...extra });
  const say = async (extra: Record<string, unknown>) => {
    const ports = fakePorts({ snapshots: [aSnapshot("ready", ready(extra))] });
    await tick(watchStarted({ lastSnapshot: "waiting", lastFacts: approving }), ports, settings());
    return ports.notifications[0]!;
  };

  test("a deploy needing approval follows: required", async () => {
    const n = await say({ expectedDeploy: { jobs: ["DEPLOY - Prod"], approval: ["prod"] } });
    expect(n.text).toContain("ready to merge; the user's involvement is required: merging starts a deploy that needs approval for prod");
    expect(n.wake).toBe(true);
  });

  test("a deploy follows: recommended", async () => {
    expect((await say({ expectedDeploy: { jobs: ["DEPLOY - Dev", "DEPLOY - Prod"], approval: [] } })).text).toContain("the user's involvement is recommended: merging deploys (2 jobs)");
  });

  test("nothing deploys: the agent may merge if asked", async () => {
    expect((await say({})).text).toContain("ready to merge; nothing deploys on merge, so the agent can merge if the user asked it to");
  });
});

describe("the model says who can act on what it flags", () => {
  test("something for a person informs; something for the agent wakes", async () => {
    const changed = { review: "REVIEW_REQUIRED" as const };
    const person = fakePorts({ snapshots: [aSnapshot("changed", changed)], verdicts: ['{"verdict":"notify","who":"person","reason":"a reviewer re-requested"}'] });
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts(changed) }), person, settings());
    expect(person.notifications[0]!.wake).toBe(false);
    const agent = fakePorts({ snapshots: [aSnapshot("changed", changed)], verdicts: ['{"verdict":"notify","who":"agent","reason":"a rollback in the logs"}'] });
    await tick(watchStarted({ lastSnapshot: "before", lastFacts: aFacts(changed) }), agent, settings());
    expect(agent.notifications[0]!.wake).toBe(true);
  });
});

describe("a person's turn doesn't reach the session because the PR also has something for the agent", () => {
  test("a run approval on a conflicting PR stays in the panel", async () => {
    const conflict = { branch: "CONFLICT" as const, checks: "PENDING" as const };
    const ports = fakePorts({ snapshots: [aSnapshot("approval", { ...conflict, waitingChecks: ["Plan"] })], verdicts: ['{"verdict":"wait"}'] });
    await tick(watchStarted({ lastSnapshot: "conflict", lastFacts: aFacts(conflict) }), ports, settings());
    expect(ports.notifications.every((n) => !n.wake)).toBe(true);
  });
});
