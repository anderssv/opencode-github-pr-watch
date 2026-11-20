import { parseComments, type CommentRead } from "./comments";
import type { Gh } from "./github";
import { classifyGhError } from "./github-health";
import type { CheckView, PrView } from "./pr-facts";

/** What one read of a PR gives: its state and checks, and who commented (never the text). */
export interface PrRead {
  readonly view: PrView;
  readonly comments: CommentRead;
}

const COMMENT_FIELDS = "id url authorAssociation author { login __typename }";

// Read every round: what a PR's progress depends on, plus the markers that tell whether the rest has changed. Costs
// the minimum (one point) for a few dozen PRs.
const CHEAP_SELECTION = `
  headRefOid state isDraft baseRefName title url reviewDecision mergeStateStatus mergedAt updatedAt
  mergeCommit { oid }
  autoMergeRequest { mergeMethod }
  author { login __typename }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts {
    totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
  } } } } }`;

// Read only when the head commit or the check counts changed: the check list, for names, links and progress.
const CHECKS_SELECTION = `
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state createdAt }
  } } } } } }`;

// Read only when the PR's updatedAt changed (comments, reviews, requested reviewers do change it).
const TALK_SELECTION = `
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
  reviewThreads(first: 100) { nodes { isResolved path comments(last: 20) { nodes { ${COMMENT_FIELDS} } } } }
  timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }`;

// What doesn't change these markers (a thread resolved, a check renamed) is caught by reading again after a while.
const CHECKS_AT_LEAST_EVERY_MS = 5 * 60_000;
const TALK_AT_LEAST_EVERY_MS = 10 * 60_000;

interface Known {
  readonly head: string;
  readonly counts: string;
  readonly updatedAt: string;
  readonly checks: Node[];
  readonly checksAt: number;
  readonly talk: { reviewRequests: Node; comments: Node; reviewThreads: Node; timelineItems?: Node };
  readonly talkAt: number;
}

type Node = Record<string, any>;

export function toPrView(pr: Node): PrView {
  const contexts: Node[] = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checks = contexts.map((c): CheckView =>
    c.__typename === "StatusContext"
      ? { context: c.context, state: c.state, startedAt: c.createdAt }
      : {
          name: c.name, status: c.status, conclusion: c.conclusion, startedAt: c.startedAt, detailsUrl: c.detailsUrl,
          // Like gh: "" for a check run outside Actions (code scanning uploads), which the pipeline leaves out.
          workflowName: c.checkSuite?.workflowRun?.workflow?.name ?? "",
        });
  const reviewers = (pr.reviewRequests?.nodes ?? []).map((n: Node) => n.requestedReviewer).filter(Boolean)
    .map((r: Node) => (r.login ? { login: r.login } : { name: r.name }));
  return {
    headRefOid: pr.headRefOid,
    ...(pr.author ? { author: { login: pr.author.login, is_bot: pr.author.__typename === "Bot" } } : {}),
    state: pr.state, isDraft: pr.isDraft, baseRefName: pr.baseRefName, title: pr.title, url: pr.url,
    reviewDecision: pr.reviewDecision ?? "", mergeStateStatus: pr.mergeStateStatus,
    autoMergeRequest: pr.autoMergeRequest ?? null,
    reviewRequests: reviewers,
    mergedAt: pr.mergedAt ?? null, mergeCommit: pr.mergeCommit ?? null,
    statusCheckRollup: checks,
  };
}

interface Request {
  readonly repo: string;
  readonly pr: number;
  readonly waiters: { resolve: (read: PrRead) => void; reject: (err: unknown) => void }[];
}

const REPO = /^([\w.-]+)\/([\w.-]+)$/;

// Only the state and the counts, so the marker is the same whether or not the check list is in the answer.
/** Raised when the batcher changes, so a running process replaces the one it kept across a reload. */
export const PR_BATCHER_VERSION = 3;

const countsOf = (node: Node) => {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  return rollup ? JSON.stringify([rollup.state, rollup.contexts?.totalCount, rollup.contexts?.checkRunCountsByState, rollup.contexts?.statusContextCountsByState]) : "";
};

/**
 * Collects the PRs asked for within a short window and reads them together through GraphQL, which has no ETags:
 * first the cheap part for all of them, then the check list and the comments only for the PRs where those changed.
 */
export class PrBatcher {
  private pending = new Map<string, Request>();
  private cwd = ".";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly known = new Map<string, Known>();

  constructor(private readonly gh: Gh, private readonly windowMs = 500, private readonly maxBatch = 50, private readonly now: () => number = Date.now) {}

  read(repo: string, pr: number, cwd: string): Promise<PrRead> {
    if (!REPO.test(repo)) return Promise.reject(new Error(`Not a repository: ${repo}`));
    if (!Number.isInteger(pr) || pr <= 0) return Promise.reject(new Error(`Not a PR number: ${pr}`));
    return new Promise((resolve, reject) => {
      const key = `${repo}#${pr}`;
      const request = this.pending.get(key) ?? { repo, pr, waiters: [] };
      request.waiters.push({ resolve, reject });
      this.pending.set(key, request);
      this.cwd = cwd;
      this.timer ??= setTimeout(() => this.flush(), this.windowMs);
    });
  }

  private flush(): void {
    this.timer = undefined;
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (let i = 0; i < requests.length; i += this.maxBatch) void this.send(requests.slice(i, i + this.maxBatch), this.cwd);
  }

  private async send(requests: Request[], cwd: string): Promise<void> {
    const cheap = await this.query(requests.map((r) => ({ request: r, selection: CHEAP_SELECTION })), cwd);
    const now = this.now();
    const needs = new Map<Request, { checks: boolean; talk: boolean }>();
    for (const r of requests) {
      const node = cheap.nodes.get(r);
      if (!node) continue;
      const kept = this.known.get(`${r.repo}#${r.pr}`);
      needs.set(r, {
        checks: !kept || kept.head !== node.headRefOid || kept.counts !== countsOf(node) || now - kept.checksAt > CHECKS_AT_LEAST_EVERY_MS,
        talk: !kept || kept.updatedAt !== node.updatedAt || now - kept.talkAt > TALK_AT_LEAST_EVERY_MS,
      });
    }
    const detailed = [...needs].filter(([, need]) => need.checks || need.talk);
    const details = detailed.length > 0
      ? await this.query(detailed.map(([r, need]) => ({ request: r, selection: (need.checks ? CHECKS_SELECTION : "") + (need.talk ? TALK_SELECTION : "") })), cwd)
      : { nodes: new Map<Request, Node>(), errors: new Map<Request, unknown>(), viewer: cheap.viewer };
    for (const r of requests) {
      const node = cheap.nodes.get(r);
      const key = `${r.repo}#${r.pr}`;
      const kept = this.known.get(key);
      const need = needs.get(r);
      const extra = details.nodes.get(r);
      const missing = !node ? cheap.errors.get(r) : need && (need.checks || need.talk) && !extra && !kept ? details.errors.get(r) : undefined;
      if (!node || missing) {
        for (const w of r.waiters) w.reject(missing ?? new Error(`PR ${key} not found`));
        continue;
      }
      // A detail read that failed falls back to the last one; its markers stay old, so it's asked again next round.
      const checks: Node[] = extra && need?.checks ? (extra.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) : (kept?.checks ?? []);
      const talk = extra && need?.talk
        ? { reviewRequests: extra.reviewRequests, comments: extra.comments, reviewThreads: extra.reviewThreads, timelineItems: extra.timelineItems }
        : (kept?.talk ?? { reviewRequests: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] } });
      this.known.set(key, {
        head: extra && need?.checks ? node.headRefOid : (kept?.head ?? ""),
        counts: extra && need?.checks ? countsOf(node) : (kept?.counts ?? ""),
        checks,
        checksAt: extra && need?.checks ? now : (kept?.checksAt ?? 0),
        updatedAt: extra && need?.talk ? node.updatedAt : (kept?.updatedAt ?? ""),
        talk,
        talkAt: extra && need?.talk ? now : (kept?.talkAt ?? 0),
      });
      const full = { ...node, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] }, ...talk };
      const viewer = cheap.viewer ?? details.viewer;
      const closer = node.state === "CLOSED" ? (talk.timelineItems as Node | undefined)?.nodes?.[0]?.actor?.login : undefined;
      const read: PrRead = {
        view: { ...toPrView(full), ...(closer && closer === viewer?.login ? { closedByViewer: true as const } : {}) },
        comments: parseComments({ data: { viewer: cheap.viewer ?? details.viewer, repository: { pullRequest: full } } }),
      };
      for (const w of r.waiters) w.resolve(read);
    }
  }

  /** One GraphQL call with a selection per PR; a failing call is split so only the PR it fails for fails. */
  private async query(parts: { request: Request; selection: string }[], cwd: string): Promise<{ nodes: Map<Request, Node>; errors: Map<Request, unknown>; viewer?: Node }> {
    const nodes = new Map<Request, Node>();
    const errors = new Map<Request, unknown>();
    const query = `query {\n  viewer { login }\n${parts
      .map(({ request, selection }, i) => {
        const [, owner, name] = request.repo.match(REPO)!;
        return `  p${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${request.pr}) {${selection}\n  } }`;
      })
      .join("\n")}\n}`;
    let answer: { data?: Node; errors?: { path?: string[]; message: string }[] };
    try {
      answer = JSON.parse(await this.gh(["api", "graphql", "-f", `query=${query}`], cwd));
    } catch (err) {
      // gh exits non-zero when any part of the answer has an error, such as one PR that no longer exists. Unless GitHub
      // itself is out of reach, each PR is then asked for alone, so only that one fails.
      const down = classifyGhError(err instanceof Error ? err.message : String(err)) !== undefined;
      if (parts.length > 1 && !down) {
        const alone = await Promise.all(parts.map((part) => this.query([part], cwd)));
        for (const one of alone) {
          for (const [r, n] of one.nodes) nodes.set(r, n);
          for (const [r, e] of one.errors) errors.set(r, e);
        }
        return { nodes, errors, ...(alone.find((one) => one.viewer)?.viewer ? { viewer: alone.find((one) => one.viewer)!.viewer } : {}) };
      }
      for (const { request } of parts) errors.set(request, err);
      return { nodes, errors };
    }
    parts.forEach(({ request }, i) => {
      const node = answer.data?.[`p${i}`]?.pullRequest;
      if (node) nodes.set(request, node);
      else errors.set(request, new Error(answer.errors?.find((e) => e.path?.[0] === `p${i}`)?.message ?? `PR ${request.repo}#${request.pr} not found`));
    });
    return { nodes, errors, ...(answer.data?.viewer ? { viewer: answer.data.viewer } : {}) };
  }
}
