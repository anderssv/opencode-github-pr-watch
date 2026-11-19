import type { Progress, RunWithJobs } from "./pr-facts";
import { runFacts } from "./run-facts";

/** A workflow run followed as part of a PR watch (a dispatch on the PR's branch), not as a watch of its own. */
export interface AttachedRun {
  readonly run: number;
  readonly workflow: string;
  readonly url: string;
  readonly state: "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED";
  readonly progress?: Progress;
  readonly waitingJobs?: readonly string[];
  readonly failedJobs?: readonly string[];
}

export function attachedRun(run: RunWithJobs): AttachedRun {
  const facts = runFacts(run);
  const state = facts.deploy === "WAITING" || facts.deploy === "SUCCEEDED" || facts.deploy === "FAILED" ? facts.deploy : "RUNNING";
  return {
    run: run.databaseId,
    workflow: run.workflowName,
    url: run.url,
    state,
    ...(facts.deployProgress ? { progress: facts.deployProgress } : {}),
    ...(state === "WAITING" ? { waitingJobs: facts.waitingJobs } : {}),
    ...(state === "FAILED" && facts.failedRun?.jobs?.length ? { failedJobs: facts.failedRun.jobs } : {}),
  };
}

const stateText = (run: AttachedRun): string | undefined => {
  switch (run.state) {
    case "SUCCEEDED": return `run ${run.workflow} succeeded`;
    case "FAILED": return `run ${run.workflow} failed (${run.url})${run.failedJobs?.length ? `: ${run.failedJobs.join(", ")}` : ""}`;
    case "WAITING": return `run ${run.workflow} needs run approval: ${(run.waitingJobs ?? []).join(", ")}`;
    case "RUNNING": return undefined;
  }
};

/** What changed in the attached runs since the last check: each run that ended or started waiting, once. */
export function attachedRunEvents(before: readonly AttachedRun[] | undefined, now: readonly AttachedRun[]): string[] {
  return now.flatMap((run) => {
    const earlier = before?.find((b) => b.run === run.run);
    if (earlier?.state === run.state) return [];
    const text = stateText(run);
    return text ? [text] : [];
  });
}

/** The runs to keep following: those not finished yet. */
export const unfinished = (runs: readonly AttachedRun[]): number[] =>
  runs.filter((run) => run.state === "RUNNING" || run.state === "WAITING").map((run) => run.run);

/** The attached run ids to keep: all but those seen finished. A run that couldn't be read this time stays. */
export function keptRuns(ids: readonly number[], seen: readonly AttachedRun[]): number[] {
  const finished = new Set(seen.filter((run) => run.state === "SUCCEEDED" || run.state === "FAILED").map((run) => run.run));
  return ids.filter((id) => !finished.has(id));
}

/** For a run that ended before anyone asked to follow it: how it ended. Undefined while it still has a way to go. */
export function alreadyFinished(run: AttachedRun): string | undefined {
  if (run.state === "SUCCEEDED") return `run ${run.workflow} already succeeded (${run.url})`;
  if (run.state === "FAILED") return `run ${run.workflow} already failed (${run.url})${run.failedJobs?.length ? `: ${run.failedJobs.join(", ")}` : ""}`;
  return undefined;
}
