import { readAnswer, type AnswerSpec } from "./answer";

export type VerdictKind = "wait" | "notify" | "done" | "failed";

export interface Verdict {
  readonly kind: VerdictKind;
  readonly reason: string;
  /** Who can act on it: the agent (it goes to the session) or a person (it shows in the panel only). */
  readonly who?: "agent" | "person";
}

// "done" and "failed" come from an earlier prompt and are still read; the prompt only offers notify and wait.
export const VERDICT_ANSWER = {
  verdict: { kind: "choice", values: ["wait", "notify", "done", "failed"], shown: ["notify", "wait"], fallback: "notify" },
  reason: { kind: "text", hint: "one short sentence", optional: true },
  who: { kind: "choice", values: ["agent", "person"], fallback: "agent", optional: true },
} as const satisfies AnswerSpec;

// Anything we can't read becomes "notify": a needless wake-up is better than silently waiting forever.
export function parseVerdict(text: string, onInvalid?: (problem: string) => void): Verdict {
  const read = readAnswer(VERDICT_ANSWER, text);
  if (!read.ok) {
    onInvalid?.(read.problem);
    return { kind: "notify", reason: `could not read the judge's answer: ${text.slice(0, 200)}` };
  }
  for (const problem of read.problems) onInvalid?.(problem);
  return {
    kind: read.value.verdict as VerdictKind,
    reason: (read.value.reason as string | undefined) ?? "",
    ...(read.value.who === "person" ? { who: "person" as const } : {}),
  };
}
