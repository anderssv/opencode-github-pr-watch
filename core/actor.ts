import { nextStep, type PrFacts, type Step } from "./pr-facts";

/**
 * Who has to do something for the PR to move on. This decides what is said and how loudly; only "done" ends a watch.
 * - nobody: it is moving on its own (checks, deploy, auto-merge).
 * - agent: something to fix in the code or the branch, which the watching session can do.
 * - person: a review, a run approval, the merge, or a draft to mark ready.
 * - done: deployed, merged without a deploy, or closed.
 */
export type Actor = "nobody" | "agent" | "person" | "done";

const BY_STEP: Record<Step, Actor | ((facts: PrFacts) => Actor)> = {
  WAIT_CHECKS: "nobody",
  WAIT_DEPLOY: "nobody",
  WAIT_DEPLOY_START: "nobody",
  DEPLOYING: "nobody",
  READY: (f) => (f.autoMerge ? "nobody" : "person"),
  UPDATE_BRANCH: (f) => (f.autoMerge ? "nobody" : "agent"),
  FIX_CHECKS: "agent",
  ADDRESS_REVIEW: "agent",
  RESOLVE_CONFLICT: "agent",
  DEPLOY_FAILED: (f) => (f.standaloneRun ? "done" : "agent"),
  DEPLOY_UNIDENTIFIED: "agent",
  NEEDS_REVIEW: "person",
  CHECKS_WAITING: "person",
  CHECKS_BLOCKED: "person",
  DEPLOY_WAITING: "person",
  DEPLOY_BLOCKED: "person",
  DRAFT: "person",
  DEPLOYED: "done",
  NO_DEPLOY: "done",
  NOTHING_TO_DEPLOY: "done",
  CLOSED: "done",
};

export function whoActs(facts: PrFacts, now: number): Actor {
  const actor = BY_STEP[nextStep(facts, now)];
  return typeof actor === "function" ? actor(facts) : actor;
}
