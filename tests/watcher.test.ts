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
    expect(ports.notifications).toEqual([{ sessionID: "ses_parent", text: expect.stringContaining("approved") }]);
    expect(ports.notifications[0]!.text).toContain("summary: APPROVED");
    expect(result.stop).toBe(false);
  });

  test("ready for merge keeps watching: said once as a change of step, then it waits for the merge", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("approved", { review: "APPROVED" }), aSnapshot("approved", { review: "APPROVED" })] });

    const first = await tick(watchStarted({ lastSnapshot: "waiting", lastFacts: aFacts({ review: "REVIEW_REQUIRED" }) }), ports, settings());
    expect(first.stop).toBe(false);
    expect(first.delayMs).toBe(5 * 60_000 - (NOW % (5 * 60_000)) || 5 * 60_000);
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

  test("stops on a failed deploy and hands back to the agent", async () => {
    // The model's diagnosis of the failure feeds the suggestion.
    const before = aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" });
    const ports = fakePorts({ snapshots: [aSnapshot("failed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "FAILED" })] });
    ports.diagnosis = { kind: "real", cause: "CVE in libexpat1" };

    const result = await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: before }), ports, settings());

    expect(result.stop).toBe(true);
    expect(ports.notifications).toHaveLength(1);
    expect(ports.notifications[0]!.text).toContain("deploy failed");
    expect(ports.notifications[0]!.text).toContain("suggestion: fix needed: CVE in libexpat1");
  });

  test("a step after the deploy failed: says the service was deployed (event-bridge#293)", async () => {
    const before = aFacts({ state: "MERGED", mergedAt: NOW - 600_000, deploy: "RUNNING" });
    const ports = fakePorts({ snapshots: [aSnapshot("failed", { state: "MERGED", mergedAt: NOW - 600_000, deploy: "FAILED" })] });
    ports.diagnosis = { kind: "real", cause: "Register release failed in DEPLOY - Prod", afterDeploy: true };

    await tick(watchStarted({ lastSnapshot: "deploying", lastFacts: before }), ports, settings());

    const text = ports.notifications[0]!.text;
    expect(text).toContain("watch stopped: deployed, but a step after the deploy failed");
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

    expect(ports.notifications).toEqual([{ sessionID: "ses_parent", text: expect.stringContaining("new commit ccccccc") }]);
  });

  test("a new commit long after the update is news again", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("updated", after)] });

    await tick(watchStarted({ lastSnapshot: "before", lastFacts: before, expectedCommitSince: NOW - 11 * 60_000 }), ports, settings());

    expect(ports.notifications).toEqual([{ sessionID: "ses_parent", text: expect.stringContaining("new commit bbbbbbb") }]);
  });

  test("a branch update on a watched PR expects its commit", () => {
    expect(awaitTrigger(aWatch(), "update-branch", 5_000).expectedCommitSince).toBe(5_000);
    expect(awaitTrigger(aWatch(), "rerun", 5_000).expectedCommitSince).toBeUndefined();
  });
});

describe("tick: waiting", () => {
  test("keeps waiting for review well past 30 minutes, polling every five minutes", async () => {
    const facts = aFacts({ review: "REVIEW_REQUIRED" });
    const ports = fakePorts({ snapshots: [aSnapshot("waiting", { review: "REVIEW_REQUIRED" })] });

    const result = await tick(
      watchStarted({ startedAt: NOW - 5 * 3_600_000, phase: "review", phaseSince: NOW - 5 * 3_600_000, lastSnapshot: "waiting", lastFacts: facts }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(false);
    expect(result.delayMs).toBe(5 * 60_000);
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
    expect(second.delayMs).toBe(60_000);
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

  test("ends a pipeline phase after 30 minutes and says how to keep watching", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 31 * 60_000, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(true);
    expect(ports.notifications[0]!.text).toContain("checks still running after 30 minutes");
    expect(ports.notifications[0]!.text).toContain("call watch_pr again");
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
    expect(result.delayMs).toBe(60_000);
    expect(ports.notifications).toEqual([]);
  });

  test("stops waiting once the new run starts, then ends if that run fails too", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", { checks: "PENDING" }), aSnapshot("failing again", failing)] });

    const running = await tick(watchStarted({ lastSnapshot: "failing", lastFacts: aFacts(failing), awaiting }), ports, settings());
    const failedAgain = await tick(running.watch, ports, settings());

    expect(running.stop).toBe(false);
    expect(running.watch.awaiting).toBeUndefined();
    expect(failedAgain.stop).toBe(true);
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

    expect(ports.notifications[0]!.text).toContain("watch stopped: behind main (opened by app/renovate)");
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

  test("hands back past the learned limit, with the basis and the model's stall check", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });
    ports.stall = "looks stuck: no step finished in 20 min";
    const limit = { limitMs: 18 * 60_000, basis: "normally under 12 min (p90 of last 20 runs)" };

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 19 * 60_000, phaseLimit: limit, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(true);
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

  test("past the doubled limit it hands back, even if still progressing", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("running", moving)] });
    ports.stall = "looks slow but progressing: apply still advancing";
    const limit = { limitMs: 36 * 60_000, basis: "normally under 12 min (p90 of last 20 runs)", extended: true };

    const result = await tick(
      watchStarted({ phase: "checks", phaseSince: NOW - 37 * 60_000, phaseLimit: limit, lastSnapshot: "running", lastFacts: aFacts(moving) }),
      ports,
      settings(),
    );

    expect(result.stop).toBe(true);
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

    expect(lines.find((l) => l.event === "check")?.fields).toMatchObject({ id: "acme/api#42", step: "DEPLOY_FAILED", events: ["deploy failed"], changed: true });
    expect(lines.find((l) => l.event === "notify")?.fields.text).toContain("deploy failed");
    expect(lines.find((l) => l.event === "result")?.fields).toMatchObject({ stop: true });
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

describe("notify: every step change by rule (major), progress too (all) — acme/admin#41", () => {
  const running = { checks: "PENDING" as const, review: "REVIEW_REQUIRED" as const, checksProgress: { done: 3, total: 5, current: "Scan" } };
  const passed = { checks: "PASS" as const, review: "REVIEW_REQUIRED" as const };

  test("checks that finish and pass are reported, without asking the model", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("all passed", passed)] });
    const result = await tick(watchStarted({ lastSnapshot: "running", lastFacts: aFacts(running) }), ports, settings());
    expect(result.stop).toBe(false);
    expect(ports.notifications[0]!.text).toContain("checks passed; now waiting for code review");
    expect(ports.judged).toEqual([]);
  });

  test("progress within a step is left to the model by default", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("4 of 5", { ...running, checksProgress: { done: 4, total: 5, current: "Build" } })], verdicts: ['{"verdict":"wait"}'] });
    await tick(watchStarted({ lastSnapshot: "3 of 5", lastFacts: aFacts(running) }), ports, settings());
    expect(ports.notifications).toEqual([]);
    expect(ports.judged).toHaveLength(1);
  });

  test("with notify all, progress within a step is reported too", async () => {
    const ports = fakePorts({ snapshots: [aSnapshot("4 of 5", { ...running, checksProgress: { done: 4, total: 5, current: "Build" } })] });
    await tick(watchStarted({ lastSnapshot: "3 of 5", lastFacts: aFacts(running), notify: "all" }), ports, settings());
    expect(ports.notifications[0]!.text).toContain("checks running 4/5 · Build");
    expect(ports.judged).toEqual([]);
  });
});
