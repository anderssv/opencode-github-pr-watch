import { answerShape } from "./answer";
import { noDebugLog, tolerate, type DebugLog } from "./debug-log";
import { stepChangeText, stepDetail } from "./watch-rows";
import { keptRuns } from "./attached-runs";
import { PROGRESSING, type PhaseLimit } from "./timing";
import { failureSignature, needsBotAdvice, suggestionFor, type Diagnosis } from "./advice";
import { resolveJudgeModel, type CatalogModel, type ModelRef, type PinnedProvider, type SessionView } from "./model-guard";
import { nextStep, summaryLine, type PrFacts } from "./pr-facts";
import { whoActs } from "./actor";
import { problemOf, approvalText, approvalWait, endReason, events, phaseOf, pollDelay, reminderDue, stillAwaiting, stuckJobs, type Trigger } from "./policy";
import { parseVerdict, VERDICT_ANSWER } from "./verdict";

const JUDGE_FAILURE_REPORT_MS = 30 * 60_000;


export interface Watch {
  /** The learned time limit for the current build or deploy phase. */
  readonly phaseLimit?: PhaseLimit;
  /** Identifies this watch; starting a new watch on the same PR replaces it with a new token. */
  readonly token?: string;
  readonly id: string;
  readonly sessionID: string;
  readonly repo: string;
  readonly pr: number;
  /** Set for a watch on a workflow run without a PR; `pr` is then 0. */
  readonly run?: number;
  /** Runs followed as part of this PR watch (a dispatch on its branch), until each has finished. */
  readonly runs?: readonly number[];
  readonly pinned: PinnedProvider;
  readonly startedAt: number;
  readonly lastChangeAt: number;
  readonly lastCheckedAt?: number;
  readonly lastSnapshot?: string;
  readonly lastFacts?: PrFacts;
  readonly stuckReported?: boolean;
  /** The approval wait last reported to the user, so a watch started during a wait says it once. */
  readonly approvalReported?: string;
  /** Set when the PR was started together with others; their progress is reported together. */
  readonly batchID?: string;
  /** Set when a command that will change the PR (rerun, branch update) started the watch, so the stale state doesn't end it right away. */
  readonly awaiting?: { readonly trigger: Trigger; readonly since: number };
  /** Set by a branch update: the merge commit it creates is expected, so it isn't reported as a new commit. */
  readonly expectedCommitSince?: number;
  /** The phase the PR was in at the last check, when it entered it, and when a review reminder was last sent. */
  readonly phase?: string;
  readonly phaseSince?: number;
  readonly lastReminderAt?: number;
  /** When judging changes started failing (model or network errors); cleared when it works again. */
  readonly judgeFailingSince?: number;
  readonly judgeFailureReported?: boolean;
  /** When the PR was first seen ready for merge; it is only said once a second check agrees. */
  readonly readySince?: number;
  /** "all" also reports progress within a step (each check or job); the default reports each change of step. */
  readonly notify?: "major" | "all";
}

/** The PR as text for the model and the listing, plus structured facts when the PR could be read. */
export interface Snapshot {
  readonly text: string;
  readonly facts?: PrFacts;
}

export interface WatchSettings {
  readonly pluginDirectory: string;
  readonly preferences: readonly string[];
  readonly stuckMs: number;
  readonly pipelineLimitMs?: number;
}

export interface WatchPorts {
  snapshot(watch: Watch): Promise<Snapshot>;
  session(sessionID: string): Promise<SessionView>;
  catalog(): Promise<CatalogModel[]>;
  judge(model: ModelRef, directory: string, prompt: string): Promise<string>;
  /** wake: the agent is woken to act on it; otherwise it only informs. */
  notify(sessionID: string, text: string, wake?: boolean): Promise<void>;
  /** Reads the failure's error lines and asks the (guarded) model for a diagnosis. */
  diagnose?(model: ModelRef, watch: Watch, facts: PrFacts): Promise<Diagnosis | undefined>;
  /** Records one more occurrence of a failure and returns how often it was seen before, across watches. */
  countFailure?(id: string, signature: string, failureKey?: string): Promise<number>;
  /** Structured diagnostics: what each check saw and decided. */
  debug?: DebugLog;
  /** Who most recently turned auto-merge off, from the PR's event history. */
  lastAutoMergeActor?(watch: Watch): Promise<string | undefined>;
  /** Asks the (guarded) model which PR replaced a closed bot PR, if any. */
  replacementFor?(model: ModelRef, watch: Watch): Promise<number | undefined>;
  /** Asks the (guarded) model how to get the bot behind a PR to refresh it, from the PR description. */
  adviseBot?(model: ModelRef, watch: Watch, situation: string): Promise<string | undefined>;
  /** How long this phase's workflows normally take, from their history. */
  phaseLimit?(watch: Watch, facts: PrFacts, phase: string): Promise<PhaseLimit | undefined>;
  /** Asks the (guarded) model whether a run past its limit looks stuck or just slow. */
  evaluateStall?(model: ModelRef, watch: Watch, facts: PrFacts, basis: string): Promise<string | undefined>;
  /** A fresh read right before sending: whether this watch is still the current one for its PR, and the live facts. */
  current(watch: Watch): Promise<{ owned: boolean; facts?: PrFacts }>;
  now(): number;
}

export interface TickResult {
  readonly watch: Watch;
  readonly stop: boolean;
  readonly delayMs: number;
  /** A PR that replaced this one; the plugin starts watching it. */
  readonly follow?: number;
}

const ACTIVE_POLL_MS = 60_000;
const RESUME_HINT = "call watch_pr again to resume";

/** Starts the grace period after a command like `gh pr update-branch`, so the state it replaces isn't reported. */
export function awaitTrigger(watch: Watch, trigger: Trigger, now: number): Watch {
  return { ...watch, awaiting: { trigger, since: now }, ...(trigger === "update-branch" ? { expectedCommitSince: now } : {}) };
}

const EXPECTED_COMMIT_MS = 10 * 60_000;

export function judgePrompt(watch: Watch, snapshot: string): string {
  return [
    `You are watching GitHub pull request ${watch.id} from review until it is deployed to production.`,
    "Approval, review changes, failing checks, branch behind or in conflict, merge, close, and deploy started/waiting/failed/succeeded",
    "are already reported to the developer separately. Your job is everything else: decide whether this change is worth telling them.",
    "",
    `Answer with JSON only: ${answerShape(VERDICT_ANSWER)}`,
    "- wait: progress or noise the developer doesn't need (a check finished, a run moved to the next job).",
    "- notify: something unexpected or worth acting on that the events above don't cover (a run that 'succeeded'",
    "  but logs a rollback, a check unexpectedly slow or cancelled).",
    "Never guess what anyone intended or wanted; state what happened and leave the judgement to the reader.",
    "Skipped jobs and checks are expected: the pipelines skip steps by design (for example deploy jobs on PR builds,",
    "or components a change didn't touch). Never report a skipped step.",
    "Jobs are created as a run reaches them, and a job list can be partial or ordered differently between two states.",
    "A job missing from one state that was in an earlier one is not news: never report jobs as disappearing or no longer appearing.",
    "",
    "Which workflow runs belong to this PR:",
    "- The PR's own outcome is the runs triggered by the merge: event [push], started at or after the merge time.",
    "- Other runs on the same commit, such as [schedule] or [workflow_dispatch], are not the PR's outcome: they run later on whatever is on main.",
    "  Never report them as the PR failing or as a regression caused by it. If one fails and it matters (for example it blocks future deploys),",
    "  use notify and say plainly that it is a separate run, not this PR's deploy.",
    "- Compare run start times with the merge time when in doubt.",
    "",
    "Previous state:",
    watch.lastSnapshot ?? "(none, this is the first look)",
    "",
    "New state:",
    snapshot,
  ].join("\n");
}

class Abort {
  constructor(readonly reason: "superseded" | "stale") {}
}

export async function tick(watch: Watch, ports: WatchPorts, settings: WatchSettings): Promise<TickResult> {
  const log = (event: string, fields: Record<string, unknown> = {}) => ports.debug?.(event, { id: watch.id, ...fields });
  let checked: Promise<void> | undefined;
  let usedFacts: PrFacts | undefined;
  const gate = () =>
    (checked ??= ports.current(watch).then(({ owned, facts: live }) => {
      if (!owned) throw new Abort("superseded");
      if (live && usedFacts && nextStep(live, ports.now()) !== nextStep(usedFacts, ports.now())) throw new Abort("stale");
    }));
  try {
    // Every message is checked against a fresh read first: a replaced watch never speaks, and a message the live
    // state no longer supports (for example "ready for merge" after the PR merged) is dropped for the next check.
    const say = async (message: string, wake = false) => {
      await gate();
      log("notify", { text: message, wake });
      await tolerate(debugOf(ports), "notify", ports.notify(watch.sessionID, `${watch.id}: ${message}`, wake), undefined, { id: watch.id });
    };
    const result = await tickInner(watch, ports, settings, (f) => (usedFacts = f), say);
    log("result", { stop: result.stop, delayMs: result.delayMs, ...(result.follow !== undefined ? { follow: result.follow } : {}) });
    return result;
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
    log("dropped", { reason: err.reason });
    if (err.reason === "superseded") return { watch, stop: true, delayMs: 0 };
    return { watch: { ...watch, lastCheckedAt: ports.now() }, stop: false, delayMs: ACTIVE_POLL_MS };
  }
}

async function tickInner(watch: Watch, ports: WatchPorts, settings: WatchSettings, use: (f: PrFacts) => void, say: (message: string, wake?: boolean) => Promise<void>): Promise<TickResult> {
  let session: SessionView;
  try {
    session = await ports.session(watch.sessionID);
  } catch {
    return { watch, stop: true, delayMs: 0 };
  }

  const snapshot = await ports.snapshot(watch);
  const now = ports.now();
  const facts = snapshot.facts;
  if (facts) use(facts);
  if (!facts) return { watch: { ...watch, lastCheckedAt: now }, stop: false, delayMs: ACTIVE_POLL_MS };

  const changed = snapshot.text !== watch.lastSnapshot;
  const current = phaseOf(facts, now);
  const phase = "phase" in current ? current.phase : undefined;
  const phaseSince = phase !== undefined && phase === watch.phase && watch.phaseSince !== undefined ? watch.phaseSince : now;
  let next: Watch = {
    ...watch,
    lastSnapshot: snapshot.text,
    lastFacts: facts,
    lastCheckedAt: now,
    lastChangeAt: changed ? now : watch.lastChangeAt,
    ...(phase !== undefined ? { phase, phaseSince } : {}),
  };
  if (watch.runs?.length) {
    const kept = keptRuns(watch.runs, facts.attachedRuns ?? []);
    next = kept.length > 0 ? { ...next, runs: kept } : (({ runs: _done, ...rest }) => rest)(next);
  }
  // Once the new run shows up, the trigger has done its job; later failures count again.
  if (watch.awaiting && !stillAwaiting(watch.awaiting, facts, now)) {
    const { awaiting: _done, ...rest } = next;
    next = rest;
  }
  if (phase === "checks" || phase === "deploy") {
    if (phase !== watch.phase || !watch.phaseLimit) {
      const limit = await tolerate(debugOf(ports), "phase limit", ports.phaseLimit?.(watch, facts, phase), undefined, { id: watch.id });
      next = limit ? { ...next, phaseLimit: limit } : withoutPhaseLimit(next);
    }
  } else {
    next = withoutPhaseLimit(next);
  }
  const summary = summaryLine(facts, now);

  let found = events(watch.lastFacts, facts, now);
  if (found.includes("auto-merge disabled")) {
    const actor = await tolerate(debugOf(ports), "auto-merge actor", ports.lastAutoMergeActor?.(watch), undefined, { id: watch.id });
    if (actor) found = found.map((e) => (e === "auto-merge disabled" ? `auto-merge disabled by ${actor}` : e));
  }
  // A watch that starts while something already waits has no transition to report, so remember what was reported.
  const wait = approvalWait(facts);
  const waitKey = wait ? `${wait.kind}:${wait.names.join("|")}` : undefined;
  if (wait && waitKey !== watch.approvalReported && !found.some((e) => e.startsWith("run approval needed"))) found.push(approvalText(wait));
  if (waitKey) next = { ...next, approvalReported: waitKey };
  else if (next.approvalReported !== undefined) {
    const { approvalReported: _cleared, ...rest } = next;
    next = rest;
  }
  let expectedCommitArrived = false;
  if (watch.expectedCommitSince !== undefined) {
    const newCommit = found.findIndex((event) => event.startsWith("new commit "));
    const expected = now - watch.expectedCommitSince < EXPECTED_COMMIT_MS;
    expectedCommitArrived = newCommit >= 0 && expected;
    if (expectedCommitArrived) found = found.filter((_, i) => i !== newCommit);
    if (newCommit >= 0 || !expected) {
      const { expectedCommitSince: _done, ...rest } = next;
      next = rest;
    }
  }
  ports.debug?.("check", {
    id: watch.id, step: nextStep(facts, now), phase, changed, events: found,
    ...(watch.awaiting ? { awaiting: watch.awaiting.trigger } : {}), summary,
  });
  const end = endReason(facts, {
    phaseSince,
    now,
    ...(watch.lastChangeAt !== undefined ? { lastChangeAt: changed ? now : watch.lastChangeAt } : {}),
    ...(next.awaiting ? { awaiting: next.awaiting } : {}),
    ...(next.phaseLimit
      ? { pipelineLimitMs: next.phaseLimit.limitMs }
      : settings.pipelineLimitMs !== undefined ? { pipelineLimitMs: settings.pipelineLimitMs } : {}),
  });
  if (end) ports.debug?.("end", { id: watch.id, end });
  if (next.readySince !== undefined) {
    const { readySince: _gone, ...rest } = next;
    next = rest;
  }
  if (end) {
    const what = found.length > 0 ? `${found.join("; ")}. ` : "";
    if ("phase" in current) {
      // Still running past its limit: say what it normally takes, and let the model judge stuck or slow.
      const basis = next.phaseLimit?.basis;
      const stall = basis ? await stallCheck(watch, facts, ports, settings, session, basis) : undefined;
      // Still progressing: give it as long again, once, without a message; hand back if it stalls or passes that too.
      if (stall?.startsWith(PROGRESSING) && next.phaseLimit && !next.phaseLimit.extended) {
        const extended: Watch = { ...next, phaseLimit: { ...next.phaseLimit, limitMs: next.phaseLimit.limitMs * 2, extended: true } };
        return { watch: extended, stop: false, delayMs: pollDelay(facts, now, next.awaiting !== undefined) };
      }
      const detail = [basis, stall].filter(Boolean).join("; ");
      await say(`${what}watch stopped: ${end}${detail ? ` (${detail})` : ""}. ${summary}`, true);
      return { watch: next, stop: true, delayMs: 0 };
    }
    if (facts.state === "CLOSED" && facts.authorIsBot) {
      const model = await guardedModel(watch, ports, settings, session);
      const replacement = model ? await tolerate(debugOf(ports), "replacement PR", ports.replacementFor?.(model, watch), undefined, { id: watch.id }) : undefined;
      if (replacement !== undefined) {
        await say(`${what}watch stopped: ${end}; superseded by #${replacement}, now watching it. ${summary}`, true);
        return { watch: next, stop: true, delayMs: 0, follow: replacement };
      }
    }
    const advice = await adviceFor(watch, facts, ports, settings, session, now);
    const author = facts.state === "OPEN" && facts.author ? ` (opened by ${facts.author})` : "";
    // The model saw the job's steps: the service shipped and only a step after it failed.
    const stated = advice?.afterDeploy ? `deployed, but a step after the deploy failed: ${advice.cause}` : end;
    const suggestion = advice ? ` suggestion${advice.fromPr ? " (read from the bot's PR description, verify before acting)" : ""}: ${advice.text}.` : "";
    await say(`${what}watch stopped: ${stated}${author}.${suggestion} ${summary}`, true);
    return { watch: next, stop: true, delayMs: 0 };
  }
  // Every change of where the PR is gets said by rule, so the end of something announced (checks restarted) is never
  // left to the model, which may call it routine. With notify "all", progress within a step is said too.
  // The commit a branch update creates, and the checks it restarts, are the caller's own doing.
  // Something to fix, or a person held up, is said when it appears, with the facts and a suggestion; the watch goes on.
  const problem = problemOf(facts, now);
  if (problem !== undefined && watch.lastFacts && problemOf(watch.lastFacts, now) !== problem) {
    const advice = await adviceFor(watch, facts, ports, settings, session, now);
    const author = facts.state === "OPEN" && facts.author ? ` (opened by ${facts.author})` : "";
    // The model saw the job's steps: the service shipped and only a step after it failed.
    const stated = advice?.afterDeploy ? `deployed, but a step after the deploy failed: ${advice.cause}` : problem;
    const suggestion = advice ? `; suggestion${advice.fromPr ? " (read from the bot's PR description, verify before acting)" : ""}: ${advice.text}` : "";
    // The problem line says what the plain event would, with more detail.
    const step = nextStep(facts, now);
    found = found.filter(
      (e) => !(stated.startsWith(e) || (step === "DEPLOY_FAILED" && e === "deploy failed") || (step === "FIX_CHECKS" && e.startsWith("checks failed"))),
    );
    found.push(`${stated}${author}${suggestion}`);
  }
  if (found.length === 0 && watch.lastFacts && !expectedCommitArrived) {
    if (nextStep(watch.lastFacts, now) !== nextStep(facts, now)) found.push(stepChangeText(watch.lastFacts, facts, now));
    else if (watch.notify === "all" && stepDetail(watch.lastFacts, now) !== stepDetail(facts, now)) found.push(stepDetail(facts, now));
  }
  // Becoming ready for merge is where a person has to act, so it's named even when other events already explain why.
  const nowReady = phase === "ready" && watch.lastFacts !== undefined && nextStep(watch.lastFacts, now) !== "READY";
  if (nowReady && found.length > 0 && !found.some((event) => event.includes("ready to merge"))) found.push("now ready to merge");
  // The agent is woken for what it can act on: something to fix. A person's turn and the PR moving on only inform.
  if (found.length > 0) await say(`${found.join("; ")}. ${summary}`, whoActs(facts, now) === "agent");
  if (reminderDue(facts, phaseSince, watch.lastReminderAt, now)) {
    const hours = Math.round((now - phaseSince) / 3_600_000);
    await say(phase === "approval" && wait ? `still waiting for run approval (${hours} h): ${wait.names.join(", ")}. ${summary}` : `still waiting for code review (${hours} h). ${summary}`);
    next = { ...next, lastReminderAt: now };
  }

  const stuck = stuckJobs(facts, now, settings.stuckMs);
  if (stuck.length > 0 && !watch.stuckReported) await say(`looks stuck: ${stuck.join(", ")}. ${summary}`, true);
  next = { ...next, stuckReported: stuck.length > 0 };

  // The update's own commit changes the snapshot in expected ways; don't ask the model to explain it.
  // An instance that took over another folder's watch (its own folder had no instance after a restart) can't use a
  // model there: the guard only allows the session's own folder. It follows the facts and leaves judging until the
  // watch's own folder has an instance again.
  const takenOver = !sameFolder(watch.pinned.directory, settings.pluginDirectory);
  if (changed && found.length === 0 && !expectedCommitArrived && takenOver) {
    ports.debug?.("judge-skipped", { id: watch.id, reason: "taken over from another folder", directory: settings.pluginDirectory });
  }
  if (changed && found.length === 0 && !expectedCommitArrived && !takenOver) {
    const resolved = resolveJudgeModel({
      pinned: watch.pinned,
      session,
      pluginDirectory: settings.pluginDirectory,
      catalog: await ports.catalog(),
      preferences: settings.preferences,
    });
    if (!resolved.ok) {
      await say(`watch stopped without calling a model, because ${resolved.reason}; ${RESUME_HINT}.`, true);
      return { watch: next, stop: true, delayMs: 0 };
    }
    try {
      const answer = await ports.judge(resolved.model, watch.pinned.directory, judgePrompt(watch, snapshot.text));
      const verdict = parseVerdict(answer, (problem) =>
        ports.debug?.("model-answer-invalid", { id: watch.id, call: "judge", model: `${resolved.model.providerID}/${resolved.model.id}`, problem, answer: answer.slice(0, 1_000) }),
      );
      ports.debug?.("judge", { id: watch.id, model: `${resolved.model.providerID}/${resolved.model.id}`, verdict: verdict.kind, ...("reason" in verdict ? { reason: verdict.reason } : {}) });
      if (verdict.kind !== "wait") await say(`${verdict.reason} ${summary}`, true);
      const { judgeFailingSince: _since, judgeFailureReported: _reported, ...rest } = next;
      next = rest;
    } catch (err) {
      // Connection errors come and go; the change is judged again on the next check, and only a lasting failure is reported.
      ports.debug?.("judge", { id: watch.id, error: err });
      const since = watch.judgeFailingSince ?? now;
      next = { ...next, judgeFailingSince: since, ...(watch.lastSnapshot !== undefined ? { lastSnapshot: watch.lastSnapshot } : {}) };
      if (now - since >= JUDGE_FAILURE_REPORT_MS && !watch.judgeFailureReported) {
        await say(`could not judge changes for ${Math.round((now - since) / 60_000)} minutes (${err instanceof Error ? err.message : String(err)}); still watching. ${summary}`);
        next = { ...next, judgeFailureReported: true };
      }
    }
  }

  return { watch: next, stop: false, delayMs: pollDelay(facts, now, next.awaiting !== undefined, next.lastChangeAt) };
}

// The suggestion is advice for the main agent, which decides. A failure gets a diagnosis from the guarded model when
// one is available, and a rerun is suggested at most once for the same failure.
async function adviceFor(
  watch: Watch,
  facts: PrFacts,
  ports: WatchPorts,
  settings: WatchSettings,
  session: SessionView,
  now: number,
): Promise<{ text: string; fromPr?: true; afterDeploy?: true; cause?: string } | undefined> {
  if (needsBotAdvice(facts, now)) {
    const model = await guardedModel(watch, ports, settings, session);
    const situation = facts.branch === "CONFLICT" ? `in conflict with ${facts.baseRefName}` : `behind ${facts.baseRefName}`;
    const advice = model ? await logged(ports, watch, "bot-advice", ports.adviseBot?.(model, watch, situation)) : undefined;
    // The PR description is untrusted text; the agent is told where the advice came from.
    if (advice) return { text: advice, fromPr: true };
    const fallback = suggestionFor(facts, now);
    return fallback ? { text: fallback } : undefined;
  }
  const signature = failureSignature(facts, now);
  if (!signature) {
    const text = suggestionFor(facts, now);
    return text ? { text } : undefined;
  }
  const before = await tolerate(debugOf(ports), "failure count", ports.countFailure?.(watch.id, signature, facts.failureKey), 0, { id: watch.id });
  const model = await guardedModel(watch, ports, settings, session);
  const diagnosis: Diagnosis | undefined = model ? await logged(ports, watch, "diagnosis", ports.diagnose?.(model, watch, facts)) : undefined;
  const text = suggestionFor(facts, now, diagnosis, before);
  const after = diagnosis?.afterDeploy && nextStep(facts, now) === "DEPLOY_FAILED" ? { afterDeploy: true as const, cause: diagnosis.cause } : {};
  return text ? { text, ...after } : undefined;
}

const withoutPhaseLimit = (watch: Watch): Watch => {
  const { phaseLimit: _limit, ...rest } = watch;
  return rest;
};

async function guardedModel(watch: Watch, ports: WatchPorts, settings: WatchSettings, session: SessionView): Promise<ModelRef | undefined> {
  const resolved = resolveJudgeModel({
    pinned: watch.pinned,
    session,
    pluginDirectory: settings.pluginDirectory,
    catalog: await tolerate(debugOf(ports), "model catalog", ports.catalog(), []),
    preferences: settings.preferences,
  });
  return resolved.ok ? resolved.model : undefined;
}

async function stallCheck(
  watch: Watch,
  facts: PrFacts,
  ports: WatchPorts,
  settings: WatchSettings,
  session: SessionView,
  basis: string,
): Promise<string | undefined> {
  const resolved = resolveJudgeModel({
    pinned: watch.pinned,
    session,
    pluginDirectory: settings.pluginDirectory,
    catalog: await tolerate(debugOf(ports), "model catalog", ports.catalog(), []),
    preferences: settings.preferences,
  });
  if (!resolved.ok) return undefined;
  return logged(ports, watch, "stall", ports.evaluateStall?.(resolved.model, watch, facts, basis));
}

const debugOf = (ports: WatchPorts): DebugLog => ports.debug ?? noDebugLog;

// An optional model call: its answer goes to the debug log; a failure is tolerated and logged.
async function logged<T>(ports: WatchPorts, watch: Watch, event: string, call: Promise<T> | undefined): Promise<T | undefined> {
  const answer = await tolerate(debugOf(ports), event, call, undefined, { id: watch.id });
  if (answer !== undefined) ports.debug?.(event, { id: watch.id, answer });
  return answer;
}

const sameFolder = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
