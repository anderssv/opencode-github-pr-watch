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

const PR_SELECTION = `
  headRefOid state isDraft baseRefName title url reviewDecision mergeStateStatus mergedAt
  mergeCommit { oid }
  autoMergeRequest { mergeMethod }
  author { login __typename }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state createdAt }
  } } } } } }
  comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
  reviewThreads(first: 100) { nodes { isResolved path comments(last: 20) { nodes { ${COMMENT_FIELDS} } } } }`;

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

/**
 * Collects the PRs asked for within a short window and reads them in one GraphQL call (one point of its budget for
 * a few dozen PRs), instead of one REST `gh pr view` each.
 */
export class PrBatcher {
  private pending = new Map<string, Request>();
  private cwd = ".";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly gh: Gh, private readonly windowMs = 500, private readonly maxBatch = 25) {}

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
    const query = `query {\n  viewer { login }\n${requests
      .map((r, i) => {
        const [, owner, name] = r.repo.match(REPO)!;
        return `  p${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${r.pr}) {${PR_SELECTION}\n  } }`;
      })
      .join("\n")}\n}`;
    let answer: { data?: Node; errors?: { path?: string[]; message: string }[] };
    try {
      answer = JSON.parse(await this.gh(["api", "graphql", "-f", `query=${query}`], cwd));
    } catch (err) {
      // gh exits non-zero when any part of the answer has an error, such as one PR that no longer exists. Unless GitHub
      // itself is out of reach, each PR is then asked for alone, so only that one fails.
      const down = classifyGhError(err instanceof Error ? err.message : String(err)) !== undefined;
      if (requests.length > 1 && !down) {
        await Promise.all(requests.map((r) => this.send([r], cwd)));
        return;
      }
      for (const r of requests) for (const w of r.waiters) w.reject(err);
      return;
    }
    requests.forEach((r, i) => {
      const node = answer.data?.[`p${i}`]?.pullRequest;
      if (!node) {
        const error = answer.errors?.find((e) => e.path?.[0] === `p${i}`)?.message ?? `PR ${r.repo}#${r.pr} not found`;
        for (const w of r.waiters) w.reject(new Error(error));
        return;
      }
      const read: PrRead = {
        view: toPrView(node),
        comments: parseComments({ data: { viewer: answer.data!.viewer, repository: { pullRequest: node } } }),
      };
      for (const w of r.waiters) w.resolve(read);
    });
  }
}
