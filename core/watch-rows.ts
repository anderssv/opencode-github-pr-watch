import { nextStep, type PrFacts, type Step } from "./pr-facts";
import type { Watch } from "./watcher";
import type { AttachedRun } from "./attached-runs";
import { progressTrack, type Stage } from "./progress";
import { whoActs } from "./actor";

export type WatchTone = "pending" | "waiting" | "failed" | "done";

export interface WatchRow {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly detail: string;
  readonly tone: WatchTone;
  /** The workflow run to open: the one still going, else a failed one, else the latest. */
  readonly runUrl?: string;
  /** What a person has to do: review the code, or approve a run into an environment. They are different people's work. */
  readonly waitingFor?: "code-review" | "run-approval";
  /** Several runs to open (the runs ahead of the PR's queued checks); `runUrl` is the first. */
  readonly runLinks?: readonly { readonly label: string; readonly url: string }[];
  /** The PR's author, state and draft flag, from the last check; absent before the first one. */
  readonly author?: string;
  readonly state?: "OPEN" | "MERGED" | "CLOSED";
  readonly draft?: boolean;
  /** Where the PR is on its way to production, stage by stage; absent before the first check. */
  readonly track?: readonly Stage[];
  /** Needs more than waiting: something to fix, or unresolved comments. A waiting line without it is just a pause. */
  readonly attention?: true;
  /** A run watch on a PR's branch: that PR, "owner/repo#number". */
  readonly forPr?: string;
}

// "3/4 · DEPLOY - Prod" while going, ", 4 steps done" once all of them are.
const progress = (p: PrFacts["checksProgress"], unit = "") =>
  !p ? "" : p.done === p.total ? `, ${p.total}${unit} done` : ` ${p.done}/${p.total}${p.current ? ` · ${p.current}` : ""}`;

// GitHub blocks the merge until every required check reports; one that never ran looks like "running" otherwise.
const missing = (f: PrFacts) =>
  `${f.checksProgress ? `${f.checksProgress.done === f.checksProgress.total ? f.checksProgress.total : `${f.checksProgress.done}/${f.checksProgress.total}`} checks done; ` : ""}required check not reported: ${f.missingChecks.join(", ")}`;

const STEPS: Record<Step, { detail: (facts: PrFacts) => string; tone: WatchTone }> = {
  DRAFT: { detail: () => "draft", tone: "waiting" },
  RESOLVE_CONFLICT: { detail: (f) => `conflicts with ${f.baseRefName}`, tone: "failed" },
  FIX_CHECKS: { detail: (f) => `checks failed: ${f.failingChecks.join(", ")}`, tone: "failed" },
  ADDRESS_REVIEW: { detail: () => "changes requested", tone: "waiting" },
  UPDATE_BRANCH: { detail: (f) => `behind ${f.baseRefName}`, tone: "waiting" },
  WAIT_CHECKS: { detail: (f) => (f.checks === "MISSING" ? missing(f) : `checks running${progress(f.checksProgress)}`), tone: "pending" },
  CHECKS_WAITING: { detail: (f) => `run approval needed: ${f.waitingChecks.join(", ")}`, tone: "waiting" },
  CHECKS_BLOCKED: {
    detail: (f) =>
      `checks queued behind runs waiting for run approval: ${(f.blockedChecks ?? []).map((b) => `${b.workflow} (behind ${short(b.title)})`).join(", ")}` +
      (f.review === "REVIEW_REQUIRED" ? " · waiting for code review" : ""),
    tone: "waiting",
  },
  NEEDS_REVIEW: { detail: (f) => `waiting for code review${f.reviewers?.length ? ` from ${f.reviewers.join(", ")}` : ""}`, tone: "waiting" },
  WAIT_DEPLOY: { detail: (f) => `waiting for ${f.baseRefName} to finish deploying`, tone: "pending" },
  READY: { detail: (f) => (f.autoMerge ? "auto-merging" : "ready to merge"), tone: "waiting" },
  WAIT_DEPLOY_START: { detail: () => "merged, deploy starting", tone: "pending" },
  DEPLOYING: { detail: (f) => `deploying${progress(f.deployProgress, " steps")}`, tone: "pending" },
  DEPLOY_WAITING: { detail: (f) => `run approval needed: ${f.waitingJobs.join(", ")}`, tone: "waiting" },
  DEPLOY_FAILED: { detail: () => "deploy failed", tone: "failed" },
  DEPLOY_BLOCKED: { detail: (f) => `deploy queued behind ${f.blockedBy?.title ?? "another run"} waiting for approval`, tone: "waiting" },
  DEPLOYED: { detail: () => "deployed", tone: "done" },
  NO_DEPLOY: { detail: () => "merged, no deploy", tone: "done" },
  NOTHING_TO_DEPLOY: { detail: () => "merged, nothing to deploy", tone: "done" },
  DEPLOY_UNIDENTIFIED: { detail: () => "deploy workflow unknown", tone: "waiting" },
  CLOSED: { detail: () => "closed", tone: "done" },
};

const RUN_STEPS: Partial<Record<Step, { detail: (facts: PrFacts) => string; tone: WatchTone }>> = {
  DEPLOYING: { detail: (f) => `running${progress(f.deployProgress, " steps")}`, tone: "pending" },
  DEPLOY_WAITING: { detail: (f) => `run approval needed: ${f.waitingJobs.join(", ")}`, tone: "waiting" },
  DEPLOY_FAILED: { detail: () => "failed", tone: "failed" },
  DEPLOYED: { detail: () => "succeeded", tone: "done" },
};

const runText = (run: AttachedRun) =>
  `run ${run.workflow}${run.state === "WAITING" ? " waiting for approval" : progress(run.progress)}`;

// Bot titles ("bump … from <sha> to <sha>") would fill the row; the message keeps them whole.
const short = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

/** Where the PR is, as the row says it ("waiting for code review", "checks running 3/5 · Build"). */
export function stepDetail(facts: PrFacts, now: number): string {
  const step = nextStep(facts, now);
  return ((facts.standaloneRun && RUN_STEPS[step]) || STEPS[step]).detail(facts);
}

const CHECKS_GOING = new Set<Step>(["WAIT_CHECKS", "CHECKS_WAITING", "CHECKS_BLOCKED"]);
const APPROVAL_WAITS = new Set<Step>(["CHECKS_WAITING", "DEPLOY_WAITING"]);

/** A change of step, said as a fact: "checks passed; now waiting for code review", or "now <where it is>". */
export function stepChangeText(before: PrFacts, after: PrFacts, now: number): string {
  const was = nextStep(before, now);
  const passed = CHECKS_GOING.has(was) && after.checks === "PASS";
  const approved = APPROVAL_WAITS.has(was) && !APPROVAL_WAITS.has(nextStep(after, now)) && after.checks !== "FAIL" && after.deploy !== "FAILED";
  return `${passed ? "checks passed; " : approved ? "run approval given; " : ""}now ${stepDetail(after, now)}`;
}

const titleOf = (watch: Watch) =>
  watch.lastSnapshot?.split("\n")[0]?.replace(/^(PR|Run): /, "").replace(/ \(https:\/\/\S+\)$/, "");

/** The session's watches as rows for a UI: what each PR is and where it is now. */
export function watchRows(watches: readonly Watch[], sessionID: string, now: number): WatchRow[] {
  return watches
    .filter((watch) => watch.sessionID === sessionID)
    .map((watch) => {
      const title = titleOf(watch);
      const going = watch.lastFacts?.attachedRuns?.find((run) => run.state === "RUNNING");
      const approving = watch.lastFacts?.attachedRuns?.find((run) => run.state === "WAITING");
      const stepName = watch.lastFacts ? nextStep(watch.lastFacts, now) : undefined;
      const blocked = stepName === "CHECKS_BLOCKED" ? (watch.lastFacts?.blockedChecks ?? []) : [];
      const step = stepName ? ((watch.lastFacts?.standaloneRun && RUN_STEPS[stepName]) || STEPS[stepName]) : undefined;
      const base = step && watch.lastFacts ? step.detail(watch.lastFacts) : "not checked yet";
      const unresolved = watch.lastFacts?.state === "OPEN" ? (watch.lastFacts.unresolvedThreads ?? 0) : 0;
      const comments = unresolved > 0 ? ` · ${unresolved} unresolved comment${unresolved === 1 ? "" : "s"}` : "";
      const tone: WatchTone = approving ? "waiting" : going && step?.tone !== "failed" ? "pending" : (step?.tone ?? "pending");
      return {
        id: watch.id,
        ...(watch.lastFacts?.author ? { author: watch.lastFacts.author } : {}),
        ...(watch.lastFacts && ["OPEN", "MERGED", "CLOSED"].includes(watch.lastFacts.state) ? { state: watch.lastFacts.state as "OPEN" | "MERGED" | "CLOSED" } : {}),
        ...(watch.lastFacts?.draft ? { draft: true } : {}),
        ...(watch.lastFacts ? { track: progressTrack(watch.lastFacts, now) } : {}),
        ...(watch.lastFacts?.forPr !== undefined ? { forPr: `${watch.repo}#${watch.lastFacts.forPr}` } : {}),
        label: title ? `${watch.id} ${title}` : watch.id,
        url: watch.run ? `https://github.com/${watch.repo}/actions/runs/${watch.run}` : `https://github.com/${watch.repo}/pull/${watch.pr}`,
        detail: (approving
          ? `run approval needed: ${approving.workflow} (${(approving.waitingJobs ?? []).join(", ")}) · ${base}`
          : base + (going ? ` · ${runText(going)}` : "")) + comments,
        // A run waiting for approval needs a person; one that is going makes the row pending, unless the PR has failed.
        // Unresolved review comments need an answer, so they turn a line that is otherwise fine yellow.
        tone: unresolved > 0 && (tone === "pending" || tone === "done") ? "waiting" : tone,
        ...(unresolved > 0 || (watch.lastFacts && whoActs(watch.lastFacts, now) === "agent") ? { attention: true as const } : {}),
        ...(approving || ["CHECKS_WAITING", "CHECKS_BLOCKED", "DEPLOY_WAITING"].includes(stepName ?? "")
          ? { waitingFor: "run-approval" as const }
          : stepName === "NEEDS_REVIEW" ? { waitingFor: "code-review" as const } : {}),
        ...(blocked.length > 0
          ? { runUrl: blocked[0]!.url, runLinks: blocked.map((b) => ({ label: `Open the run ahead of ${b.workflow}`, url: b.url })) }
          : (approving ?? going) ? { runUrl: (approving ?? going)!.url } : watch.lastFacts?.runUrl ? { runUrl: watch.lastFacts.runUrl } : {}),
      };
    });
}

/** Every session's watches as rows, the session with the most recently started watch first. */
export function sessionGroups(watches: readonly Watch[], now: number): { sessionID: string; watches: WatchRow[] }[] {
  const latest = new Map<string, number>();
  for (const watch of watches) latest.set(watch.sessionID, Math.max(latest.get(watch.sessionID) ?? 0, watch.startedAt));
  return [...latest]
    .sort((a, b) => b[1] - a[1])
    .map(([sessionID]) => ({ sessionID, watches: watchRows(watches, sessionID, now) }));
}
