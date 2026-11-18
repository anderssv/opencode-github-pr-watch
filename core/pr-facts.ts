import type { AttachedRun } from "./attached-runs";

export interface CheckView {
  readonly name?: string;
  readonly context?: string;
  readonly workflowName?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
  readonly startedAt?: string;
  readonly detailsUrl?: string;
}

export interface PrView {
  readonly headRefOid?: string;
  readonly author?: { readonly login: string; readonly is_bot?: boolean };
  readonly state: string;
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly title: string;
  readonly url: string;
  readonly reviewDecision: string;
  readonly mergeStateStatus: string;
  readonly autoMergeRequest: unknown;
  readonly mergedAt: string | null;
  readonly mergeCommit: { readonly oid: string } | null;
  readonly statusCheckRollup: readonly CheckView[];
}

export interface JobView {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly startedAt: string;
}

export interface RunWithJobs {
  readonly databaseId: number;
  readonly workflowName: string;
  readonly event: string;
  readonly createdAt: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
  readonly jobs: readonly JobView[];
  /** Which attempt of the run this is; a rerun keeps the run's link and counts this up. */
  readonly attempt?: number;
  /** Its recent successful runs had deploy jobs; set for running runs whose deploy jobs may not be listed yet. */
  readonly usuallyDeploys?: boolean;
  /** The model's judgement of the workflow: part of shipping the service, or something else (docs, scans, analysis). */
  readonly role?: "deploy" | "other";
}

export type Review = "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "NOT_REQUIRED";
export type Branch = "OK" | "BEHIND" | "CONFLICT" | "UNKNOWN";
export type Checks = "PASS" | "PENDING" | "FAIL" | "MISSING" | "NONE";
export type Deploy = "NOT_MERGED" | "NO_RUNS" | "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" | "UNIDENTIFIED" | "NOTHING" | "BLOCKED";
export type Step =
  | "DRAFT" | "RESOLVE_CONFLICT" | "FIX_CHECKS" | "ADDRESS_REVIEW" | "UPDATE_BRANCH" | "WAIT_CHECKS" | "CHECKS_WAITING" | "CHECKS_BLOCKED" | "NEEDS_REVIEW" | "WAIT_DEPLOY" | "READY"
  | "WAIT_DEPLOY_START" | "DEPLOYING" | "DEPLOY_WAITING" | "DEPLOY_FAILED" | "DEPLOY_BLOCKED" | "DEPLOYED" | "NO_DEPLOY" | "DEPLOY_UNIDENTIFIED" | "NOTHING_TO_DEPLOY" | "CLOSED";

export interface Progress {
  readonly done: number;
  readonly total: number;
  /** The job or check running now, when one is. */
  readonly current?: string;
}

export interface PrFacts {
  /** A workflow run followed on its own, without a PR: the deploy fields describe that run. */
  readonly standaloneRun?: true;
  /** For a watched run: the open PR on the run's branch, whose line shows the run. */
  readonly forPr?: number;
  /** Runs followed as part of this PR's watch (a dispatch on its branch), with their state. */
  readonly attachedRuns?: readonly AttachedRun[];
  /** Terraform plan summaries from the PR's finished runs, per job. */
  readonly terraformPlans?: readonly { readonly job: string; readonly summary: string }[];
  /** The PR's own deploy failed, but a later successful run of the same pipeline deployed a commit containing the merge. */
  readonly deployedBy?: { readonly title: string; readonly url: string };
  /** The deploy run is queued with no jobs behind an older run of its workflow that waits for an approval; `since` is when that run started. */
  readonly blockedBy?: { readonly title: string; readonly url: string; readonly since: number };
  /** The PR's check runs queued with no jobs behind an older run of their workflow waiting for run approval. */
  readonly blockedChecks?: readonly { readonly workflow: string; readonly title: string; readonly url: string; readonly since: number }[];
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly draft: boolean;
  readonly baseRefName: string;
  readonly review: Review;
  readonly branch: Branch;
  readonly checks: Checks;
  readonly failingChecks: readonly string[];
  /** Checks the base branch requires that haven't reported on this PR at all; GitHub blocks the merge until they do. */
  readonly missingChecks: readonly string[];
  readonly mergedAt?: number;
  readonly deploy: Deploy;
  /** After a merge without deploy runs: false when nothing a merge can start deploys, so there's nothing to wait for. */
  readonly deployPossible?: boolean;
  readonly waitingJobs: readonly string[];
  /** Pipeline checks held at an environment approval before the merge (for example a plan that needs a reviewer to release it). */
  readonly waitingChecks: readonly string[];
  readonly unfinishedJobs: readonly { readonly name: string; readonly since: number }[];
  /** Merge-commit pipelines that deployed nothing because the PR didn't touch their component (monorepos). */
  readonly unaffectedPipelines: readonly string[];
  readonly autoMerge: boolean;
  readonly autoMergeBy?: string;
  readonly headSha?: string;
  readonly author?: string;
  readonly authorIsBot?: true;
  /** The workflow run to open: the one still going, else a failed one, else the latest. */
  readonly runUrl?: string;
  /** Identifies one failure: the failed check's job link, or the failed deploy run and its attempt. */
  readonly failureKey?: string;
  /** The workflow run that failed (a failing check's run, or the failed deploy run), to name and link in messages. */
  readonly failedRun?: { readonly workflow: string; readonly url: string; readonly jobs?: readonly string[] };
  /** How many of the PR's pipeline checks have finished, of those that run (skipped ones left out). */
  readonly checksProgress?: Progress;
  /** How many jobs of the deploy pipeline have finished, of those that run. */
  readonly deployProgress?: Progress;
  /** The workflows on the merge commit when none of them was judged to deploy. */
  readonly undeterminedWorkflows?: readonly string[];
  /** Merge pipelines on the base branch still deploying something this PR also changes. */
  readonly deployingOnBase: readonly string[];
  /** Before the merge: the deploy's jobs from its last successful run on the base branch, and the environments that need approval. */
  /** Review threads on the open PR that nobody has resolved; absent when they couldn't be read. */
  readonly unresolvedThreads?: number;
  /** Before any of its runs waits: the environments the PR's own workflows deploy to that need approval. */
  readonly expectedChecksApproval?: readonly string[];
  readonly expectedDeploy?: { readonly jobs: readonly string[]; readonly approval: readonly string[] };
}

// After a merge, a deploy pipeline normally starts within a few minutes. If none has started by then, the repo
// most likely has no merge-triggered deploy and there is nothing more to follow.
const DEPLOY_START_GRACE_MS = 15 * 60_000;

const REVIEWS: Record<string, Review> = { APPROVED: "APPROVED", REVIEW_REQUIRED: "REVIEW_REQUIRED", CHANGES_REQUESTED: "CHANGES_REQUESTED" };
const BRANCHES: Record<string, Branch> = { BEHIND: "BEHIND", DIRTY: "CONFLICT", UNKNOWN: "UNKNOWN" };
const FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

export const checkName = (c: CheckView) => c.name ?? c.context ?? "unnamed check";

// GitHub code scanning (Trivy, Hadolint, CodeQL results) reports as check runs without a workflow, and goes
// NEUTRAL or pending whenever the scan it compares hasn't uploaded for the new commit yet. Only the build
// pipeline decides whether a PR can merge; its own vulnerability scan job still counts.
export const pipelineChecks = (rollup: readonly CheckView[]): CheckView[] =>
  rollup.filter((c) => c.workflowName !== "" && c.workflowName !== "CodeQL");
const checkFailed = (c: CheckView) => FAILED.has((c.conclusion ?? c.state ?? "").toUpperCase());
const checkPending = (c: CheckView) =>
  c.status ? c.status.toUpperCase() !== "COMPLETED" : PENDING.has((c.state ?? "").toUpperCase());

// A re-run adds a new check run with the same name; only the latest attempt of each check counts.
export function latestAttempts(checks: readonly CheckView[]): CheckView[] {
  const latest = new Map<string, CheckView>();
  for (const check of checks) {
    const key = `${check.workflowName ?? ""}/${checkName(check)}`;
    const seen = latest.get(key);
    if (!seen || (check.startedAt ?? "") >= (seen.startedAt ?? "")) latest.set(key, check);
  }
  return [...latest.values()];
}

function checksOf(
  rollup: readonly CheckView[],
  required: readonly string[],
  rerunning: readonly string[] = [],
): Pick<PrFacts, "checks" | "failingChecks" | "missingChecks" | "waitingChecks"> {
  const reported = new Set(rollup.map(checkName));
  const missingChecks = [...new Set(required)].filter((name) => !reported.has(name)).sort();
  const pipeline = latestAttempts(pipelineChecks(rollup));
  // GitHub can keep showing the failed attempt while a re-run of its workflow is underway.
  const rerun = (c: CheckView) => c.workflowName !== undefined && rerunning.includes(c.workflowName);
  const failingChecks = pipeline.filter((c) => checkFailed(c) && !rerun(c)).map(checkName);
  const waitingChecks = pipeline.filter((c) => (c.status ?? "").toUpperCase() === "WAITING").map(checkName);
  if (failingChecks.length > 0) return { checks: "FAIL", failingChecks, missingChecks, waitingChecks };
  if (pipeline.some((c) => checkPending(c) || (checkFailed(c) && rerun(c)))) return { checks: "PENDING", failingChecks, missingChecks, waitingChecks };
  if (missingChecks.length > 0) return { checks: "MISSING", failingChecks, missingChecks, waitingChecks };
  return { checks: pipeline.length === 0 ? "NONE" : "PASS", failingChecks, missingChecks, waitingChecks };
}

// In a monorepo every component pipeline runs on each merge, and the ones the PR didn't touch skip all their
// deploy jobs. A pipeline whose deploy jobs are all skipped is therefore not part of this PR's deploy, unless
// a job failed: then the deploys were skipped because of the failure, and the deploy failed.
export const isDeployJob = (job: JobView) => /deploy/i.test(job.name);
const hasDeployJobs = (run: RunWithJobs) => run.role === "deploy" || run.jobs.some(isDeployJob) || run.usuallyDeploys === true;
const deployedNothing = (run: RunWithJobs) => {
  const deployJobs = run.jobs.filter(isDeployJob);
  return (
    deployJobs.length > 0 &&
    deployJobs.every((job) => job.conclusion === "skipped") &&
    !run.jobs.some((job) => FAILED.has(job.conclusion.toUpperCase()))
  );
};

function deployOf(
  mergedAt: number | undefined,
  runs: readonly RunWithJobs[],
  noDeploy = false,
): Pick<PrFacts, "deploy" | "waitingJobs" | "unfinishedJobs" | "unaffectedPipelines" | "undeterminedWorkflows" | "runUrl" | "deployProgress" | "failureKey"> {
  if (mergedAt === undefined) return { deploy: "NOT_MERGED", waitingJobs: [], unfinishedJobs: [], unaffectedPipelines: [] };
  if (noDeploy) return { deploy: "NOTHING", waitingJobs: [], unfinishedJobs: [], unaffectedPipelines: [] };
  const merged = runs.filter((run) => run.event === "push" && Date.parse(run.createdAt) >= mergedAt);
  // Every workflow judged and none of them deploys: say so rather than guess from job names.
  if (merged.length > 0 && merged.every((run) => run.role === "other")) {
    return { deploy: "UNIDENTIFIED", waitingJobs: [], unfinishedJobs: [], unaffectedPipelines: [], undeterminedWorkflows: [...new Set(merged.map((run) => run.workflowName))] };
  }
  const unaffectedPipelines = merged.filter(deployedNothing).map((run) => run.workflowName);
  // Workflows the model judged not part of shipping the service (docs, scans) don't affect the deploy at all.
  const relevant = merged.filter((run) => !deployedNothing(run) && run.role !== "other");
  // Workflows without deploy jobs (CodeQL, dependency submission) only decide the outcome when no pipeline
  // deploys: while a deploy pipeline exists they can fail it, but not keep it running or look stuck.
  const deploying = relevant.filter(hasDeployJobs);
  // When deploy pipelines ran but all skipped their deploys, the workflows without deploy jobs (CodeQL, docs sync) say
  // nothing about the deploy; only when the repo has no deploy pipeline at all do they decide.
  const own = deploying.length > 0 ? deploying : unaffectedPipelines.length > 0 ? [] : relevant;
  const jobs = own.flatMap((run) => run.jobs);
  const counted = jobs.filter((job) => job.conclusion !== "skipped");
  const runningJob = counted.find((job) => job.status === "in_progress")?.name;
  const deployProgress = counted.length > 0
    ? { done: counted.filter((job) => job.status === "completed").length, total: counted.length, ...(runningJob ? { current: runningJob } : {}) }
    : undefined;
  const runUrl = pickRun(own.map((run) => ({ running: run.status !== "completed", failed: FAILED.has(run.conclusion.toUpperCase()), url: run.url })));
  const waitingJobs = jobs.filter((job) => job.status === "waiting").map((job) => job.name);
  const unfinishedJobs = jobs
    .filter((job) => job.status !== "completed")
    .map((job) => ({ name: job.name, since: Date.parse(job.startedAt) }));
  // Pipelines ran and every one skipped its deploys: this change has nothing to deploy (a monorepo component it didn't
  // touch, a workflow-only change). Only once all runs on the merge commit are done, so one still deciding can't be missed.
  const nothing = own.length === 0 && unaffectedPipelines.length > 0 && merged.every((run) => run.status === "completed");
  const deploy: Deploy =
    nothing ? "NOTHING"
    : own.length === 0 ? "NO_RUNS"
    : waitingJobs.length > 0 ? "WAITING"
    : own.some((run) => run.status !== "completed") ? "RUNNING"
    : relevant.some((run) => FAILED.has(run.conclusion.toUpperCase())) ? "FAILED"
    : "SUCCEEDED";
  return { deploy, waitingJobs, unfinishedJobs, unaffectedPipelines, ...(runUrl ? { runUrl } : {}), ...(deployProgress ? { deployProgress } : {}), ...failedRunKey(own) };
}

export function factsFrom(
  view: PrView,
  runs: readonly RunWithJobs[],
  now: number,
  requiredChecks: readonly string[] = [],
  rerunningWorkflows: readonly string[] = [],
  baseRuns: readonly RunWithJobs[] = [],
  options: { readonly noDeploy?: boolean; readonly deployedBy?: PrFacts["deployedBy"]; readonly blockedBy?: PrFacts["blockedBy"] } = {},
): PrFacts {
  const mergedAt = view.mergedAt ? Date.parse(view.mergedAt) : undefined;
  const state = view.state === "MERGED" || view.state === "CLOSED" ? view.state : "OPEN";
  return {
    state,
    draft: view.isDraft,
    autoMerge: Boolean(view.autoMergeRequest),
    ...autoMergeBy(view.autoMergeRequest),
    ...(view.headRefOid ? { headSha: view.headRefOid } : {}),
    ...(view.author?.login ? { author: view.author.login } : {}),
    ...(view.author?.is_bot ? { authorIsBot: true as const } : {}),
    deployingOnBase: deployingOnBase(view.statusCheckRollup, baseRuns),
    baseRefName: view.baseRefName,
    review: REVIEWS[view.reviewDecision] ?? "NOT_REQUIRED",
    branch: BRANCHES[view.mergeStateStatus] ?? "OK",
    ...checksOf(view.statusCheckRollup, requiredChecks, rerunningWorkflows),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...checksRun(view.statusCheckRollup),
    ...blocked(coveredBy(deployOf(mergedAt, runs, options.noDeploy), options.deployedBy), runs, options.blockedBy),
  };
}

// GitHub runs one run per concurrency group at a time; the queued one has no jobs until the one ahead of it finishes.
function blocked<T extends Pick<PrFacts, "deploy" | "runUrl">>(deploy: T, runs: readonly RunWithJobs[], blocker: PrFacts["blockedBy"]): T {
  if (!blocker || deploy.deploy !== "RUNNING") return deploy;
  const queued = runs.some((run) => run.status !== "completed" && run.status !== "in_progress" && run.jobs.length === 0);
  const started = runs.some((run) => run.jobs.length > 0 && run.status !== "completed");
  return queued && !started ? { ...deploy, deploy: "BLOCKED", runUrl: blocker.url, blockedBy: blocker } : deploy;
}

function coveredBy<T extends Pick<PrFacts, "deploy" | "runUrl">>(deploy: T, later: PrFacts["deployedBy"]): T {
  if (!later || deploy.deploy !== "FAILED") return deploy;
  return { ...deploy, deploy: "SUCCEEDED", runUrl: later.url, deployedBy: later };
}

export function nextStep(facts: PrFacts, now: number): Step {
  if (facts.state === "CLOSED") return "CLOSED";
  if (facts.state === "MERGED") {
    switch (facts.deploy) {
      case "RUNNING": return "DEPLOYING";
      case "WAITING": return "DEPLOY_WAITING";
      case "FAILED": return "DEPLOY_FAILED";
      case "BLOCKED": return "DEPLOY_BLOCKED";
      case "SUCCEEDED": return "DEPLOYED";
      case "NOTHING": return "NOTHING_TO_DEPLOY";
      // Right after a merge the deploy runs may not exist yet; only other workflows so far says nothing about the deploy.
      case "UNIDENTIFIED": return facts.deployPossible === false ? "NO_DEPLOY" : now - (facts.mergedAt ?? now) < DEPLOY_START_GRACE_MS ? "WAIT_DEPLOY_START" : "DEPLOY_UNIDENTIFIED";
      default: return facts.deployPossible !== false && now - (facts.mergedAt ?? now) < DEPLOY_START_GRACE_MS ? "WAIT_DEPLOY_START" : "NO_DEPLOY";
    }
  }
  if (facts.draft) return "DRAFT";
  if (facts.branch === "CONFLICT") return "RESOLVE_CONFLICT";
  if (facts.checks === "FAIL") return "FIX_CHECKS";
  if (facts.review === "CHANGES_REQUESTED") return "ADDRESS_REVIEW";
  if (facts.branch === "BEHIND") return "UPDATE_BRANCH";
  if (facts.checks === "PENDING" && facts.waitingChecks.length > 0) return "CHECKS_WAITING";
  // Other runs ahead in the queue wait for someone's approval; this PR's checks can't start until then. Queued runs
  // have no jobs and so no check runs yet: the checks GitHub shows can all pass meanwhile.
  if ((facts.blockedChecks?.length ?? 0) > 0) return "CHECKS_BLOCKED";
  if (facts.checks === "PENDING") return "WAIT_CHECKS";
  // Not ready until every required check has reported.
  if (facts.checks === "MISSING") return "WAIT_CHECKS";
  if (facts.review === "REVIEW_REQUIRED") return "NEEDS_REVIEW";
  // Merging now would race an earlier merge that is still deploying the same pipeline.
  if (facts.deployingOnBase.length > 0) return "WAIT_DEPLOY";
  return "READY";
}

// Passing checks say nothing about what a Terraform plan will do; destroys are put first and marked.
function planText(facts: PrFacts): string {
  const changing = (facts.terraformPlans ?? []).filter((plan) => plan.summary !== "no changes");
  if (changing.length === 0) return "";
  const destroys = (plan: { summary: string }) => !/ 0 to destroy$/.test(plan.summary);
  const ordered = [...changing.filter(destroys), ...changing.filter((plan) => !destroys(plan))];
  return ` · terraform: ${ordered.map((plan) => `${plan.job} ${plan.summary}${destroys(plan) ? " (DESTROYS)" : ""}`).join("; ")}`;
}

export function summaryLine(facts: PrFacts, now: number): string {
  const next = `next: ${nextStep(facts, now)}`;
  if (facts.state === "CLOSED") return `summary: CLOSED · ${next}`;
  if (facts.state === "MERGED") {
    const deploy = facts.deploy === "WAITING" ? `WAITING:${facts.waitingJobs.join(",")}` : facts.deploy;
    return facts.standaloneRun ? `summary: RUN · ${deploy} · ${next}` : `summary: ${facts.state} · deploy ${deploy} · ${next}`;
  }
  const checks =
    facts.checks === "FAIL" ? `FAIL:${facts.failingChecks.join(",")}`
    : facts.checks === "PENDING" && facts.waitingChecks.length > 0 ? `PENDING (run approval needed: ${facts.waitingChecks.join(",")})`
    : facts.checks === "MISSING" ? `MISSING:${facts.missingChecks.join(",")}`
    : facts.checks;
  return `summary: ${facts.review} · checks ${checks} · branch ${facts.branch} · ${next}${planText(facts)}`;
}

// The pipelines this PR builds: those with a check that actually ran beyond bookkeeping. In a monorepo every component
// pipeline runs on every PR, but most only detect that nothing changed, report a status job and skip the rest; the
// pipelines a PR touches are those where a real job ran. Bookkeeping job names are a convention, so they can be set.
const DEFAULT_BOOKKEEPING = ["detect changes", "changes", "paths-filter", "paths filter", "build status", "ci status", "all checks"];
const bookkeepingPattern = (names: readonly string[]) =>
  // At the start of the name, or of a reusable workflow's job ("Web / Detect changes"); "Apply changes" is real work.
  new RegExp(`(^|/\\s*)(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
let BOOKKEEPING = bookkeepingPattern(DEFAULT_BOOKKEEPING);

/** Job names (start of the name or after "/", any case) that only detect changes or report a status. Undefined restores the defaults. */
export function setBookkeepingJobs(names: readonly string[] | undefined): void {
  BOOKKEEPING = bookkeepingPattern(names && names.length > 0 ? names : DEFAULT_BOOKKEEPING);
}
function builtWorkflows(rollup: readonly CheckView[]): Set<string> {
  return new Set(
    rollup
      .filter((c) => c.workflowName && !BOOKKEEPING.test(checkName(c)) && (c.conclusion ?? "").toUpperCase() !== "SKIPPED")
      .map((c) => c.workflowName!),
  );
}

function deployingOnBase(rollup: readonly CheckView[], baseRuns: readonly RunWithJobs[]): string[] {
  const built = builtWorkflows(rollup);
  return [
    ...new Set(
      baseRuns
        .filter((run) => run.status !== "completed" && built.has(run.workflowName))
        .filter((run) => run.jobs.some((job) => isDeployJob(job) && job.conclusion !== "skipped" && job.status !== "completed"))
        .map((run) => run.workflowName),
    ),
  ];
}

function autoMergeBy(request: unknown): { autoMergeBy?: string } {
  const login = (request as { enabledBy?: { login?: string } } | null)?.enabledBy?.login;
  return login ? { autoMergeBy: login } : {};
}

function pickRun(runs: readonly { running: boolean; failed: boolean; url: string }[]): string | undefined {
  return (runs.find((r) => r.running) ?? runs.find((r) => r.failed) ?? runs[runs.length - 1])?.url;
}

// A check's detailsUrl points at a job inside its run; the run page shows every job.
// Matrix jobs carry their matrix value in the name ("Deploy (eu-west)"), which says what failed.
const failedJobs = (run: RunWithJobs) => run.jobs.filter((job) => FAILED.has(job.conclusion.toUpperCase())).map((job) => job.name);

function failedRunKey(runs: readonly RunWithJobs[]): Pick<PrFacts, "failureKey" | "failedRun"> {
  const failed = runs.find((run) => FAILED.has(run.conclusion.toUpperCase()));
  return failed ? { failureKey: `${failed.url}#${failed.attempt ?? 1}`, failedRun: { workflow: failed.workflowName, url: failed.url, jobs: failedJobs(failed) } } : {};
}

function checksRun(rollup: readonly CheckView[]): Pick<PrFacts, "runUrl" | "checksProgress" | "failureKey" | "failedRun"> {
  const runs = latestAttempts(pipelineChecks(rollup)).flatMap((check) => {
    const url = check.detailsUrl?.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+)/)?.[1];
    return url ? [{ running: checkPending(check), failed: checkFailed(check), url }] : [];
  });
  const runUrl = pickRun(runs);
  const running = latestAttempts(pipelineChecks(rollup)).filter((check) => (check.conclusion ?? "").toUpperCase() !== "SKIPPED");
  const done = running.filter((check) => !checkPending(check)).length;
  const current = running.find(checkPending)?.name;
  const checksProgress = { done, total: running.length, ...(current ? { current } : {}) };
  const failedCheck = running.find(checkFailed);
  const failedJob = failedCheck?.detailsUrl;
  const failedRunUrl = failedJob?.match(/^(.*\/actions\/runs\/\d+)/)?.[1];
  return {
    ...(runUrl ? { runUrl } : {}),
    ...(running.length > 0 ? { checksProgress } : {}),
    ...(failedJob ? { failureKey: failedJob } : {}),
    ...(failedRunUrl ? { failedRun: { workflow: failedCheck!.workflowName ?? checkName(failedCheck!), url: failedRunUrl } } : {}),
  };
}
