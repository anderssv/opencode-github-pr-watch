/** A PR's comments, and how many of them sit in review threads, the only kind GitHub lets you resolve. */
export interface CommentCount {
  readonly total: number;
  /** Comments in review threads not yet resolved. */
  readonly unresolved: number;
  /** Review threads: none means nothing on the PR can be resolved. */
  readonly threads: number;
  /** More review threads than one page holds: the counts are at least these. */
  readonly more?: true;
}

export interface PrRef {
  readonly repo: string;
  readonly number: number;
}

interface PrComments {
  readonly pullRequest: {
    readonly comments: { readonly totalCount: number };
    readonly reviewThreads: { readonly totalCount: number; readonly nodes: readonly { readonly isResolved: boolean; readonly comments: { readonly totalCount: number } }[] };
  } | null;
}

const THREADS_PAGE = 100;

/** One GraphQL query for every PR, each under its own alias (p0, p1, …). Reviews aren't asked for: they aren't comments. */
export function commentsQuery(prs: readonly PrRef[]): string {
  const parts = prs.map((pr, i) => {
    const [owner, name] = pr.repo.split("/");
    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${pr.number}) { comments { totalCount } reviewThreads(first: ${THREADS_PAGE}) { totalCount nodes { isResolved comments { totalCount } } } } }`;
  });
  return `query { ${parts.join(" ")} }`;
}

/** The counts by "owner/repo#number": the PR's own comments plus every review thread's. A PR GitHub didn't return is left out. */
export function commentCountsFrom(data: Record<string, PrComments | null>, prs: readonly PrRef[]): Record<string, CommentCount> {
  const counts: Record<string, CommentCount> = {};
  prs.forEach((pr, i) => {
    const found = data[`p${i}`]?.pullRequest;
    if (!found) return;
    const threads = found.reviewThreads.nodes;
    const sum = (list: typeof threads) => list.reduce((n, t) => n + t.comments.totalCount, 0);
    counts[`${pr.repo}#${pr.number}`] = {
      total: found.comments.totalCount + sum(threads),
      unresolved: sum(threads.filter((t) => !t.isResolved)),
      threads: threads.length,
      ...(found.reviewThreads.totalCount > threads.length ? { more: true as const } : {}),
    };
  });
  return counts;
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/**
 * What the comment button shows: the total, coloured red when a comment is unresolved, green when every one that can
 * be resolved is, and neutral when nothing can be; nothing when there are no comments.
 */
export function commentBadge(count: CommentCount | undefined): { text: string; tone: "unresolved" | "resolved" | "neutral"; tip: string } | undefined {
  if (!count || count.total === 0) return undefined;
  const plus = count.more ? "+" : "";
  const text = `${count.total}${plus}`;
  const comments = `${text} ${plural(count.total, "comment")}`;
  if (count.unresolved > 0) return { text, tone: "unresolved", tip: `${comments}, ${count.unresolved}${plus} unresolved` };
  if (count.threads > 0) return { text, tone: "resolved", tip: `${comments}, all resolved` };
  return { text, tone: "neutral", tip: comments };
}
