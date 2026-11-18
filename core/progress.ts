import { nextStep, type PrFacts } from "./pr-facts";

/**
 * A PR's way to production as one line of stages, for the pill, the panel and progress messages. Each stage is done,
 * running, waiting on a person (yellow: a review, a run approval, the merge, a draft), failed (red), or upcoming.
 * A run approval shows on the step it holds up: the checks before the merge, the deploy after it.
 */
export type StageState = "done" | "running" | "waiting" | "failed" | "upcoming";

export interface Stage {
  readonly name: "PR" | "Checks" | "Review" | "Merge" | "Deploy" | "Run";
  readonly state: StageState;
  readonly detail?: string;
}

const stage = (name: Stage["name"], state: StageState, detail?: string): Stage => ({ name, state, ...(detail ? { detail } : {}) });
const progress = (p: PrFacts["checksProgress"]) => (p ? `${p.done}/${p.total}${p.current ? ` · ${p.current}` : ""}` : undefined);

const expected = (e: PrFacts["expectedDeploy"]) =>
  e && e.jobs.length > 0
    ? [`${e.jobs.length} jobs: ${e.jobs.join(", ")}`, ...(e.approval.length > 0 ? [`run approval for ${e.approval.join(", ")}`] : [])].join(" · ")
    : undefined;

function deployStage(facts: PrFacts, name: "Deploy" | "Run"): Stage | undefined {
  switch (facts.deploy) {
    case "RUNNING": return stage(name, "running", progress(facts.deployProgress));
    case "WAITING": return stage(name, "waiting", `run approval: ${facts.waitingJobs.join(", ")}`);
    case "BLOCKED": return stage(name, "waiting", "queued behind a run waiting for approval");
    case "FAILED": return stage(name, "failed");
    case "SUCCEEDED": return stage(name, "done");
    case "NOTHING": return undefined;
    default:
      if (facts.deployPossible === false) return undefined;
      return facts.state === "MERGED" ? stage(name, "running", "starting") : stage(name, "upcoming", expected(facts.expectedDeploy));
  }
}

export function progressTrack(facts: PrFacts, now: number): Stage[] {
  if (facts.standaloneRun) return [deployStage(facts, "Run") ?? stage("Run", "upcoming")];
  const base = facts.baseRefName;
  const merged = facts.state === "MERGED";
  const step = nextStep(facts, now);

  const pr =
    facts.state === "CLOSED" ? stage("PR", "failed", "closed")
    : merged ? stage("PR", "done")
    : facts.draft ? stage("PR", "waiting", "draft")
    : facts.branch === "CONFLICT" ? stage("PR", "failed", `conflicts with ${base}`)
    : facts.branch === "BEHIND" ? (facts.autoMerge ? stage("PR", "running", `updating from ${base}`) : stage("PR", "failed", `behind ${base}`))
    : stage("PR", "done");

  const checks =
    merged ? stage("Checks", "done")
    : facts.checks === "FAIL" ? stage("Checks", "failed", facts.failingChecks.join(", "))
    : facts.waitingChecks.length > 0 ? stage("Checks", "waiting", `run approval: ${facts.waitingChecks.join(", ")}`)
    : (facts.blockedChecks?.length ?? 0) > 0 ? stage("Checks", "waiting", "queued behind runs waiting for approval")
    : facts.checks === "PENDING" || facts.checks === "MISSING" ? stage("Checks", "running", progress(facts.checksProgress))
    : stage("Checks", "done");

  const review =
    merged || facts.review === "APPROVED" || facts.review === "NOT_REQUIRED" ? stage("Review", "done")
    : facts.review === "CHANGES_REQUESTED" ? stage("Review", "failed", "changes requested")
    : checks.state === "done" ? stage("Review", "waiting", "waiting for code review")
    : stage("Review", "upcoming");

  const merge =
    merged ? stage("Merge", "done")
    : step === "READY" ? (facts.autoMerge ? stage("Merge", "running", "auto-merge") : stage("Merge", "waiting", "ready to merge"))
    : step === "WAIT_DEPLOY" ? stage("Merge", "running", `waiting for ${base} to finish deploying`)
    : stage("Merge", "upcoming");

  const deploy = deployStage(facts, "Deploy");
  return deploy ? [pr, checks, review, merge, deploy] : [pr, checks, review, merge];
}

export const STAGE_MARKS: Record<StageState, string> = { done: "✓", running: "…", waiting: "⏸", failed: "✗", upcoming: "" };

/** "PR ✓ · Checks ✓ · Review ⏸ waiting for code review · Merge · Deploy" */
export const trackText = (stages: readonly Stage[]): string =>
  stages.map((s) => [s.name, STAGE_MARKS[s.state], s.detail].filter(Boolean).join(" ")).join(" · ");
