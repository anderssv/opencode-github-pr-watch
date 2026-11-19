import { attachedRunEvents } from "./attached-runs";
import { commentEvents } from "./comments";
import { nextStep, type PrFacts, type Step } from "./pr-facts";

const MINUTE = 60_000;
// Every watch is checked every 30 seconds, all at the same moment: the PRs come in one batched GraphQL read (no ETags
// there), and REST answers that haven't changed come back as free 304s. Waiting on people costs the same as a build.
const POLL_MS = 30_000;
const IDLE_POLL_MS = 5 * MINUTE;
const IDLE_AFTER_MS = 24 * 60 * MINUTE;
// Right after `gh run rerun` or `gh pr update-branch`, GitHub can still report the state the command is replacing
// for a little while. A watch started by such a command ignores those stale states for this long.
const TRIGGER_GRACE_MS = 10 * MINUTE;

export type Trigger = "rerun" | "update-branch" | "failed-checks" | "behind";
const STALE_AFTER: Record<Trigger, readonly Step[]> = {
  rerun: ["DEPLOY_FAILED"],
  // Checks that failed before the update are still reported until the new run starts.
  "update-branch": ["UPDATE_BRANCH", "READY", "FIX_CHECKS"],
  // A PR whose checks failed (for example just before a Dependabot recreate) usually gets a new run shortly.
  "failed-checks": ["FIX_CHECKS"],
  // A behind PR is often about to be updated (for example a pending Dependabot recreate).
  behind: ["UPDATE_BRANCH"],
};
const GRACE_MS: Record<Trigger, number> = { rerun: TRIGGER_GRACE_MS, "update-branch": TRIGGER_GRACE_MS, "failed-checks": 30 * MINUTE, behind: 30 * MINUTE };

// Steps where nothing happens until a person acts (review, merge, branch update, environment approval, rerun).
// Run approvals aren't here: they tend to come soon after the request, so they're checked every minute.

export function events(prev: PrFacts | undefined, next: PrFacts, now: number): string[] {
  if (!prev) return [];
  const found: string[] = [];
  // A new head commit restarts checks and can dismiss approval; report that once instead of its consequences.
  const newCommit = next.state === "OPEN" && prev.headSha !== undefined && next.headSha !== undefined && prev.headSha !== next.headSha;
  if (newCommit) {
    const who = next.authorIsBot ? ` (bot PR by ${next.author})` : "";
    found.push(`new commit ${next.headSha!.slice(0, 7)}${who} — checks restarted, approval may be dismissed`);
  }
  if (prev.review !== next.review) {
    if (next.review === "APPROVED") found.push("approved");
    else if (next.review === "CHANGES_REQUESTED") found.push("changes requested");
    else if (prev.review === "APPROVED" && next.review === "REVIEW_REQUIRED" && !newCommit) found.push("approval dismissed, review required again");
  }
  if (next.state === "OPEN") {
    const gated = next.waitingChecks.filter((name) => !prev.waitingChecks.includes(name));
    if (gated.length > 0) found.push(approvalText({ kind: "checks", names: gated }));
  }
  if (next.state === "OPEN" && (next.blockedChecks?.length ?? 0) > 0 && !(prev.blockedChecks?.length)) {
    found.push(`checks queued behind runs waiting for run approval: ${next.blockedChecks!.map((b) => `${b.workflow} behind ${b.title} (${b.url})`).join("; ")}`);
  }
  if (next.checks === "FAIL" && prev.checks !== "FAIL") found.push(`checks failing: ${next.failingChecks.join(", ")}`);
  if (next.branch !== prev.branch) {
    if (next.branch === "BEHIND") found.push(`behind ${next.baseRefName}, needs update`);
    if (next.branch === "OK" && prev.branch === "BEHIND") found.push(`back up to date with ${next.baseRefName}`);
    if (next.branch === "CONFLICT") found.push(`conflicts with ${next.baseRefName}`);
  }
  if (next.state !== prev.state) {
    if (next.state === "MERGED") found.push("merged");
    if (next.state === "CLOSED") found.push("closed without merging");
  }
  if (next.state === "OPEN" && prev.autoMerge !== next.autoMerge) {
    found.push(next.autoMerge ? `auto-merge enabled${next.autoMergeBy ? ` by ${next.autoMergeBy}` : ""}` : "auto-merge disabled");
  }
  found.push(...attachedRunEvents(prev.attachedRuns, next.attachedRuns ?? []));
  // The first read only notes what is there; after it, comments not seen before are said.
  if (prev.commentIds && next.comments) found.push(...commentEvents(prev.commentIds, next.comments));
  if (next.standaloneRun) {
    if (next.deploy !== prev.deploy) {
      if (next.deploy === "WAITING") found.push(`run approval needed: ${next.waitingJobs.join(", ")}`);
      if (next.deploy === "FAILED") found.push("the run failed");
      if (next.deploy === "SUCCEEDED") found.push("the run succeeded");
    }
    return found;
  }
  if (next.state === "MERGED" && next.deploy !== prev.deploy) {
    if (next.deploy === "RUNNING" && prev.deploy !== "WAITING") found.push("deploy started");
    if (next.deploy === "WAITING") found.push(approvalText({ kind: "deploy", names: next.waitingJobs }));
    if (next.deploy === "FAILED") found.push("deploy failed");
    if (next.deploy === "SUCCEEDED") found.push(next.deployedBy ? deployedByText(next.deployedBy) : "deployed (merge pipeline succeeded)");
  }
  if (nextStep(next, now) === "NO_DEPLOY" && nextStep(prev, now) !== "NO_DEPLOY" && prev.state === "MERGED") {
    found.push("merged, but no deploy started for the merge commit");
  }
  return found;
}

const runText = (facts: PrFacts) => (facts.failedRun ? ` (${facts.failedRun.workflow}, ${facts.failedRun.url})` : "");

const deployedByText = (later: NonNullable<PrFacts["deployedBy"]>) =>
  `deployed by the run of ${later.title} (${later.url}), which includes this merge; this PR's own run failed`;

export interface ApprovalWait {
  readonly kind: "checks" | "deploy";
  readonly names: readonly string[];
}

/** What is held at an environment approval right now: PR checks before the merge, the deploy after it. */
export function approvalWait(facts: PrFacts): ApprovalWait | undefined {
  if (facts.state === "OPEN" && facts.waitingChecks.length > 0) return { kind: "checks", names: facts.waitingChecks };
  if (facts.state === "MERGED" && facts.deploy === "WAITING" && facts.waitingJobs.length > 0) return { kind: "deploy", names: facts.waitingJobs };
  return undefined;
}

// A person approving a run into an environment, which is not the same as reviewing the code.
export const approvalText = (wait: ApprovalWait): string => `run approval needed (${wait.kind}): ${wait.names.join(", ")}`;

export type Phase = "review" | "approval" | "ready" | "fix" | "waiting" | "checks" | "required-checks" | "base-deploy" | "auto-merge" | "auto-update" | "deploy";

const HOUR = 60 * MINUTE;
const REMINDER_EVERY_MS = 24 * HOUR;
export const DEFAULT_PIPELINE_LIMIT_MS = 30 * MINUTE;
const AUTO_MERGE_READY_LIMIT_MS = 10 * MINUTE;
const IDLE_LIMIT_MS = 14 * 24 * HOUR;

const TIMEOUTS: Record<Exclude<Phase, "review" | "approval" | "ready" | "fix" | "waiting">, (limit: string, facts: PrFacts) => string> = {
  checks: (limit) => `checks still running after ${limit}`,
  // A required check whose workflow never triggers (for example a path filter that skips it) blocks the merge
  // forever; GitHub only shows it as BLOCKED.
  "required-checks": (limit, facts) => `required checks never reported after ${limit}: ${facts.missingChecks.join(", ")}`,
  "auto-merge": (limit) => `auto-merge hasn't merged after ${limit}`,
  "base-deploy": (limit, facts) => `an earlier merge was still deploying after ${limit}: ${facts.deployingOnBase.join(", ")}`,
  "auto-update": (limit, facts) => `behind ${facts.baseRefName} for ${limit} with auto-merge waiting`,
  deploy: (limit) => `deploy still running after ${limit}`,
};

/**
 * A watch follows the PR until it is done: deployed, merged without a deploy, or closed. Everything before that is a
 * phase: moving on its own (with a time limit), waiting on a person, or something to fix (no limit of their own).
 */
export function phaseOf(facts: PrFacts, now: number): { phase: Phase } | { end: string } {
  switch (nextStep(facts, now)) {
    case "NEEDS_REVIEW": return { phase: "review" };
    case "CHECKS_WAITING": case "CHECKS_BLOCKED": case "DEPLOY_WAITING": return { phase: "approval" };
    case "WAIT_CHECKS": return { phase: facts.checks === "MISSING" ? "required-checks" : "checks" };
    case "WAIT_DEPLOY": return { phase: facts.autoMerge ? "auto-merge" : "base-deploy" };
    // Ready without auto-merge waits for someone to merge it, so the merge leads straight into following the deploy.
    case "READY": return { phase: facts.autoMerge ? "auto-merge" : "ready" };
    case "UPDATE_BRANCH": return { phase: facts.autoMerge ? "auto-update" : "fix" };
    case "WAIT_DEPLOY_START": case "DEPLOYING": return { phase: "deploy" };
    // A watched run on its own is done when it fails: a rerun is a new run, with a watch of its own.
    case "DEPLOY_FAILED": return facts.standaloneRun ? { end: "the run failed" } : { phase: "fix" };
    case "ADDRESS_REVIEW": case "FIX_CHECKS": case "RESOLVE_CONFLICT": case "DEPLOY_UNIDENTIFIED": return { phase: "fix" };
    case "DRAFT": case "DEPLOY_BLOCKED": return { phase: "waiting" };
    case "CLOSED": return { end: "closed without merging" };
    case "DEPLOYED": return { end: facts.standaloneRun ? "the run succeeded" : facts.deployedBy ? deployedByText(facts.deployedBy) : "deployed (merge pipeline succeeded)" };
    case "NO_DEPLOY":
      return { end: facts.deployPossible === false ? "merged; nothing this change starts on a merge deploys (the deploy workflows don't run for these files or branch)" : "merged, and no deploy started for the merge commit" };
    case "NOTHING_TO_DEPLOY": return { end: "merged; nothing to deploy (no deploy job ran for this change)" };
  }
}

/** What has to be fixed, or what a person is held up by, in words for the message; undefined when nothing is wrong. */
export function problemOf(facts: PrFacts, now: number): string | undefined {
  const base = facts.baseRefName;
  switch (nextStep(facts, now)) {
    case "UPDATE_BRANCH": return facts.autoMerge ? undefined : `behind ${base}`;
    case "ADDRESS_REVIEW": return "changes requested";
    case "FIX_CHECKS": return `checks failed: ${facts.failingChecks.join(", ")}${runText(facts)}`;
    case "RESOLVE_CONFLICT": return `conflicts with ${base}`;
    case "DRAFT": return "draft";
    case "DEPLOY_BLOCKED": {
      const by = facts.blockedBy!;
      return `deploy queued behind the run of ${by.title} (${by.url}), waiting for approval (that run started ${new Date(by.since).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
    }
    case "DEPLOY_FAILED": {
      const jobs = facts.failedRun?.jobs?.length ? `: ${facts.failedRun.jobs.join(", ")}` : "";
      return `${facts.standaloneRun ? "the run failed" : `the merge pipeline failed${runText(facts)}`}${jobs}`;
    }
    case "DEPLOY_UNIDENTIFIED": return `couldn't tell which workflow deploys this repo (saw: ${(facts.undeterminedWorkflows ?? []).join(", ")})`;
    default: return undefined;
  }
}

export interface EndInput {
  /** When the PR entered its current phase. */
  readonly phaseSince: number;
  readonly now: number;
  /** Set when a command that will change the PR's state just started this watch. */
  readonly awaiting?: { readonly trigger: Trigger; readonly since: number };
  readonly pipelineLimitMs?: number;
  /** When the PR last changed; a watch with no change for 14 days ends. */
  readonly lastChangeAt?: number;
}

export function endReason(facts: PrFacts, input: EndInput): string | undefined {
  const { now } = input;
  const awaiting = input.awaiting;
  const stale = awaiting !== undefined && stillAwaiting(awaiting, facts, now);
  if (stale && now - awaiting.since < GRACE_MS[awaiting.trigger]) return undefined;
  const current = phaseOf(facts, now);
  if (stale && awaiting.trigger === "failed-checks" && "end" in current) return `${current.end}; no new run started`;
  if (stale && awaiting.trigger === "behind" && "end" in current) return `${current.end}; no update arrived`;
  if ("end" in current) return current.end;
  if (input.lastChangeAt !== undefined && now - input.lastChangeAt > IDLE_LIMIT_MS) return "nothing changed for 14 days; call watch_pr again to keep watching";
  return undefined;
}

/**
 * A running phase past its time limit: said once, and the watch goes on. Waiting on a person or a fix has no limit.
 */
export function overdue(facts: PrFacts, input: Pick<EndInput, "phaseSince" | "now" | "pipelineLimitMs">): string | undefined {
  const { now } = input;
  const current = phaseOf(facts, now);
  if ("end" in current) return undefined;
  // GitHub merges a ready auto-merge PR within a minute or two; when it hasn't, something holds it that the API doesn't show.
  if (current.phase === "auto-merge" && nextStep(facts, now) === "READY") {
    if (now - input.phaseSince < AUTO_MERGE_READY_LIMIT_MS) return undefined;
    return `approved and checks pass, but auto-merge hasn't merged after ${AUTO_MERGE_READY_LIMIT_MS / MINUTE} minutes`;
  }
  const phase = current.phase;
  if (phase === "review" || phase === "approval" || phase === "ready" || phase === "fix" || phase === "waiting") return undefined;
  const limitMs = input.pipelineLimitMs ?? DEFAULT_PIPELINE_LIMIT_MS;
  if (now - input.phaseSince < limitMs) return undefined;
  return TIMEOUTS[phase](`${Math.round(limitMs / MINUTE)} minutes`, facts);
}

export function startDecision(
  facts: PrFacts,
  now: number,
  options: { trigger?: Trigger } = {},
): { start: true; awaiting?: Awaiting } | { start: false; reason: string } {
  const step = nextStep(facts, now);
  const trigger =
    options.trigger ?? (step === "FIX_CHECKS" ? "failed-checks" : step === "UPDATE_BRANCH" && !facts.autoMerge ? "behind" : undefined);
  const awaiting = trigger ? { trigger, since: now } : undefined;
  const reason = endReason(facts, { phaseSince: now, now, ...(awaiting ? { awaiting } : {}) });
  if (reason) return { start: false, reason };
  return trigger === "failed-checks" || trigger === "behind" ? { start: true, awaiting: awaiting! } : { start: true };
}

export type Awaiting = { readonly trigger: Trigger; readonly since: number };

/** Whether the PR is still in the state the trigger is replacing, i.e. the new run hasn't shown up yet. */
export function stillAwaiting(awaiting: Awaiting, facts: PrFacts, now: number): boolean {
  return STALE_AFTER[awaiting.trigger].includes(nextStep(facts, now));
}

export function reminderDue(facts: PrFacts, phaseSince: number, lastReminderAt: number | undefined, now: number): boolean {
  const current = phaseOf(facts, now);
  if (!("phase" in current) || (current.phase !== "review" && current.phase !== "approval")) return false;
  // People don't review on weekends, so neither the reminder nor its waiting time runs then.
  return !isWeekend(now) && workingMs(lastReminderAt ?? phaseSince, now) >= REMINDER_EVERY_MS;
}

export function pollDelay(_facts: PrFacts, now: number, awaitingNewRun = false, lastChangeAt?: number): number {
  // Watches now live until the PR is done, so one that has been quiet for a day is checked less often.
  if (!awaitingNewRun && lastChangeAt !== undefined && now - lastChangeAt > IDLE_AFTER_MS) return IDLE_POLL_MS;
  return POLL_MS;
}

export function stuckJobs(facts: PrFacts, now: number, limitMs: number): string[] {
  return facts.unfinishedJobs
    .filter((job) => now - job.since > limitMs)
    .map((job) => `${job.name} (${Math.round((now - job.since) / MINUTE)} min)`);
}

// Polls snap to wall-clock multiples of their interval, so separate watches report together and land in one digest.
// A slot closer than a quarter interval away is skipped.
export function alignedDelay(now: number, intervalMs: number): number {
  const next = Math.ceil((now + intervalMs / 4) / intervalMs) * intervalMs;
  return next - now;
}

const isWeekend = (time: number) => [0, 6].includes(new Date(time).getDay());

/** Time between two moments, leaving out Saturdays and Sundays (local time). */
export function workingMs(from: number, to: number): number {
  let total = 0;
  let cursor = from;
  while (cursor < to) {
    const day = new Date(cursor);
    const nextMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const end = Math.min(nextMidnight, to);
    if (!isWeekend(cursor)) total += end - cursor;
    cursor = end;
  }
  return total;
}
