import { answerShape, readAnswer, type AnswerSpec } from "./answer";
import type { MyPr, MyPrSort } from "./my-prs";

export interface Topic {
  readonly name: string;
  /** PR ids, "owner/repo#number". */
  readonly prs: readonly string[];
}

export const prID = (pr: MyPr) => `${pr.repo}#${pr.number}`;

export const OTHER = "Other";

/** Asks the light model to sort the PRs into a few topics by what they change. */
export function topicsPrompt(prs: readonly MyPr[]): string {
  return [
    "Group these pull requests into 3 to 8 topics by what they are about (for example a feature, an area of the system,",
    "security hardening, dependency updates, CI). Use short topic names (1 to 4 words). Put every PR in exactly one topic.",
    `Answer with JSON only: ${answerShape(TOPICS_ANSWER)}`,
    "",
    "Pull requests (id: title):",
    ...prs.map((pr) => `${prID(pr)}: ${pr.title}`),
  ].join("\n");
}

/**
 * The model's topics, checked against the PRs asked about: unknown ids are dropped, a PR in several topics stays in
 * the first, and PRs it left out go to "Other". Throws when the answer isn't the JSON asked for.
 */
export const TOPICS_ANSWER = {
  topics: { kind: "list", item: { name: { kind: "text", hint: "topic", max: 60 }, prs: { kind: "list", item: { kind: "text", hint: "owner/repo#number" } } } },
} as const satisfies AnswerSpec;

export function parseTopics(text: string, prs: readonly MyPr[], onInvalid?: (problem: string) => void): Topic[] {
  const read = readAnswer(TOPICS_ANSWER, text);
  if (!read.ok) {
    onInvalid?.(read.problem);
    throw new Error(`could not read the topics: ${read.problem}`);
  }
  for (const problem of read.problems) onInvalid?.(problem);
  const parsed = read.value as { topics: { name: string; prs: string[] }[] };
  const known = new Set(prs.map(prID));
  const placed = new Set<string>();
  const topics: Topic[] = [];
  for (const topic of parsed.topics) {
    if (typeof topic.name !== "string" || !Array.isArray(topic.prs)) continue;
    const members = topic.prs.filter((id): id is string => typeof id === "string" && known.has(id) && !placed.has(id));
    members.forEach((id) => placed.add(id));
    if (members.length > 0) topics.push({ name: topic.name.trim() || OTHER, prs: members });
  }
  const rest = prs.map(prID).filter((id) => !placed.has(id));
  return rest.length > 0 ? [...topics, { name: OTHER, prs: rest }] : topics;
}

/**
 * How to get topics for the PRs now listed, given the last ones: unchanged (PRs gone are dropped, empty topics too),
 * place only the new PRs into the kept topics, or a whole new grouping when there are none yet or most PRs are new.
 */
export type TopicPlan =
  | { readonly kind: "same"; readonly topics: readonly Topic[] }
  | { readonly kind: "place"; readonly kept: readonly Topic[]; readonly fresh: readonly MyPr[] }
  | { readonly kind: "full" };

export function topicPlan(previous: readonly Topic[] | undefined, prs: readonly MyPr[]): TopicPlan {
  if (!previous) return { kind: "full" };
  const now = new Set(prs.map(prID));
  const kept = previous.map((t) => ({ name: t.name, prs: t.prs.filter((id) => now.has(id)) })).filter((t) => t.prs.length > 0);
  const known = new Set(kept.flatMap((t) => t.prs));
  const fresh = prs.filter((pr) => !known.has(prID(pr)));
  if (fresh.length === 0) return { kind: "same", topics: kept };
  return fresh.length * 2 > prs.length ? { kind: "full" } : { kind: "place", kept, fresh };
}

export const PLACEMENTS_ANSWER = {
  placements: { kind: "list", item: { pr: { kind: "text", hint: "owner/repo#number" }, topic: { kind: "text", hint: "topic", max: 60 } } },
} as const satisfies AnswerSpec;

/** Asks the light model where new PRs go: one of the existing topics, or a new short one when none fits. */
export function placePrompt(topics: readonly Topic[], fresh: readonly MyPr[]): string {
  return [
    "Put each of these new pull requests into one of the existing topics below, by what it is about.",
    "Only when none fits, give a new short topic name (1 to 4 words).",
    `Answer with JSON only: ${answerShape(PLACEMENTS_ANSWER)}`,
    "",
    "Existing topics:",
    ...topics.map((t) => `- ${t.name}`),
    "",
    "New pull requests (id: title):",
    ...fresh.map((pr) => `${prID(pr)}: ${pr.title}`),
  ].join("\n");
}

/** The kept topics with the new PRs added; names match existing topics in any case, and PRs not placed go to Other. */
export function parsePlacements(text: string, kept: readonly Topic[], fresh: readonly MyPr[], onInvalid?: (problem: string) => void): Topic[] {
  const read = readAnswer(PLACEMENTS_ANSWER, text);
  if (!read.ok) {
    onInvalid?.(read.problem);
    throw new Error(`could not read the placements: ${read.problem}`);
  }
  for (const problem of read.problems) onInvalid?.(problem);
  const topics = kept.map((t) => ({ name: t.name, prs: [...t.prs] }));
  const wanted = new Set(fresh.map(prID));
  const into = (name: string, id: string) => {
    const found = topics.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (found) found.prs.push(id);
    else topics.push({ name, prs: [id] });
  };
  for (const placement of (read.value as { placements: { pr: string; topic: string }[] }).placements) {
    if (typeof placement.pr !== "string" || !wanted.has(placement.pr)) continue;
    wanted.delete(placement.pr);
    into(typeof placement.topic === "string" && placement.topic.trim() ? placement.topic.trim() : OTHER, placement.pr);
  }
  for (const id of wanted) into(OTHER, id);
  // Other stays last.
  const other = topics.findIndex((t) => t.name === OTHER);
  return other >= 0 ? [...topics.slice(0, other), ...topics.slice(other + 1), topics[other]!] : topics;
}

const timeOf = (pr: MyPr) => Date.parse(pr.closedAt ?? pr.createdAt);
const newer = (a: MyPr, b: MyPr) => timeOf(b) - timeOf(a) || b.number - a.number;

/**
 * PRs grouped by topic, in the topics' order, PRs in the chosen order (by name keeps newest first), with the same
 * organisation and draft filters as by repo. PRs the topics don't know (opened since they were made) go to "Other".
 */
export function byTopic(prs: readonly MyPr[], topics: readonly Topic[], organisation?: string, sort: MyPrSort = "name", drafts = true): { name: string; prs: MyPr[] }[] {
  const topicOf = new Map(topics.flatMap((topic) => topic.prs.map((id) => [id, topic.name] as const)));
  const groups = new Map<string, MyPr[]>(topics.map((topic) => [topic.name, []]));
  for (const pr of prs) {
    if (organisation && !pr.repo.startsWith(`${organisation}/`)) continue;
    if (!drafts && pr.draft) continue;
    const name = topicOf.get(prID(pr)) ?? OTHER;
    groups.set(name, [...(groups.get(name) ?? []), pr]);
  }
  return [...groups]
    .filter(([, list]) => list.length > 0)
    .map(([name, list]) => ({ name, prs: [...list].sort((a, b) => (sort === "oldest" ? newer(b, a) : newer(a, b))) }));
}
