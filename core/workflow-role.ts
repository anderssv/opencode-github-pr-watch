import { answerShape, readAnswer, type AnswerSpec } from "./answer";

export type WorkflowRole = "deploy" | "other";

export interface WorkflowSummary {
  readonly name: string;
  readonly path: string;
  readonly jobs: readonly string[];
  readonly file: string;
}

export function rolePrompt(workflow: WorkflowSummary): string {
  return [
    "Classify this GitHub Actions workflow for someone waiting for a merged change to reach production.",
    "- deploy: it builds and ships the service itself to its environments (dev, test, prod).",
    "- other: anything else, even if a job is called deploy: documentation or GitHub Pages, code scanning, CodeQL,",
    "  dependency submission, linting, release notes, notifications.",
    `Answer with JSON only: ${answerShape(ROLE_ANSWER)}`,
    "",
    `Workflow: ${workflow.name} (${workflow.path})`,
    "Jobs:",
    ...workflow.jobs.map((job) => `- ${job}`),
    "Start of the workflow file:",
    workflow.file.slice(0, 3000),
  ].join("\n");
}

export const ROLE_ANSWER = { role: { kind: "choice", values: ["deploy", "other"] } } as const satisfies AnswerSpec;

export function parseRole(text: string, onInvalid?: (problem: string) => void): WorkflowRole | undefined {
  const read = readAnswer(ROLE_ANSWER, text);
  if (!read.ok) {
    onInvalid?.(read.problem);
    return undefined;
  }
  for (const problem of read.problems) onInvalid?.(problem);
  return read.value.role as WorkflowRole;
}

export function matchWorkflow(given: string, workflows: readonly { id: number; name: string; path: string }[]): number | undefined {
  const wanted = given.trim().toLowerCase();
  return workflows.find(
    (w) => w.name.toLowerCase() === wanted || w.path.toLowerCase() === wanted || w.path.toLowerCase().endsWith(`/${wanted}`),
  )?.id;
}

export const ENVIRONMENTS_ANSWER = { environments: { kind: "list", item: { kind: "text", hint: "environment name" } } } as const satisfies AnswerSpec;

/**
 * The environments a workflow's jobs deploy to when a pull request into the base branch runs it. Only asked when the
 * file sets them by an expression (often an input to a shared workflow), which no general rule can read.
 */
export function environmentsPrompt(file: string, base: string): string {
  return [
    `This GitHub Actions workflow runs for a pull request into ${base}. Which deployment environments will its jobs use then?`,
    "Work out expressions such as `${{ github.ref != 'refs/heads/main' && 'prod' || null }}` for a pull request (github.ref is",
    `refs/pull/N/merge, the base is ${base}), including environment inputs passed to shared (reusable) workflows.`,
    "List only names; leave out jobs that get no environment.",
    `Answer with JSON only: ${answerShape(ENVIRONMENTS_ANSWER)}`,
    "",
    file.slice(0, 8000),
  ].join("\n");
}

export function parseEnvironments(text: string, onInvalid?: (problem: string) => void): string[] | undefined {
  const read = readAnswer(ENVIRONMENTS_ANSWER, text);
  if (!read.ok) {
    onInvalid?.(read.problem);
    return undefined;
  }
  for (const problem of read.problems) onInvalid?.(problem);
  return (read.value.environments as unknown[]).filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim());
}
