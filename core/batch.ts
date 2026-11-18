import { parsePrReference } from "./github";
import { nextStep, type PrFacts } from "./pr-facts";

export function parsePrReferences(text: string): { refs: { repo?: string; pr: number }[]; invalid: string[] } {
  const refs: { repo?: string; pr: number }[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const ref = parsePrReference(token);
    if (ref) refs.push(ref);
    else invalid.push(token);
  }
  return { refs, invalid };
}

export function batchLabel(titles: readonly string[]): string {
  const unique = new Set(titles);
  return unique.size === 1 ? titles[0]! : `${titles.length} PRs`;
}

export function batchProgress(label: string, all: readonly (PrFacts | undefined)[], now: number): string {
  // A PR closed without merging is out of the batch's work; counting it would keep "merged 2/3" forever.
  const closed = all.filter((f) => f?.state === "CLOSED").length;
  const facts = all.filter((f) => f?.state !== "CLOSED");
  const total = facts.length;
  const known = facts.filter((f): f is PrFacts => f !== undefined);
  const approved = known.filter((f) => f.review === "APPROVED" || f.review === "NOT_REQUIRED" || f.state === "MERGED").length;
  const merged = known.filter((f) => f.state === "MERGED").length;
  const deployed = known.filter((f) => nextStep(f, now) === "DEPLOYED").length;
  return `${label}: approved ${approved}/${total} · merged ${merged}/${total} · deployed ${deployed}/${total}${closed > 0 ? ` · closed ${closed}` : ""}`;
}

export function composeDigest(messages: readonly string[], progress: readonly string[]): string {
  progress = [...new Set(progress)];
  if (messages.length === 1) return [messages[0]!, ...progress].join("\n");
  return [`${messages.length} PR updates:`, ...messages.map((m) => `- ${m}`), ...progress].join("\n");
}

export interface Batch {
  readonly label: string;
  readonly members: readonly string[];
  readonly facts: Readonly<Record<string, PrFacts | undefined>>;
}

/** A bot PR superseded by a new one: the new PR takes the old one's place in the batch. */
export function replaceMember(batch: Batch, oldID: string, newID: string, facts?: PrFacts): Batch {
  const { [oldID]: _old, ...rest } = batch.facts;
  return { ...batch, members: batch.members.map((m) => (m === oldID ? newID : m)), facts: { ...rest, [newID]: facts } };
}

export function withoutMember(batch: Batch, id: string): Batch {
  if (!batch.members.includes(id)) return batch;
  const { [id]: _gone, ...rest } = batch.facts;
  return { ...batch, members: batch.members.filter((m) => m !== id), facts: rest };
}
