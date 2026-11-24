/**
 * Who said something on a PR, never what: the text of a comment from anyone who can comment would go straight into
 * the agent's context. Only comments from the repo's collaborators count; bots and the gh user are left out.
 */
export interface PrComment {
  readonly id: string;
  readonly author: string;
  /** The file, for a review comment. */
  readonly path?: string;
  readonly url: string;
  /** From a bot: only its review comments (Copilot's reviewer) are kept, not its conversation comments. */
  readonly bot?: true;
}

export interface CommentRead {
  readonly unresolvedThreads: number;
  /** Every comment there now, by anyone; the next read reports those not among them. */
  readonly commentIds: readonly string[];
  /** The collaborators' comments, which may be reported. */
  readonly comments: readonly PrComment[];
}

interface CommentNode {
  readonly id: string;
  readonly url: string;
  readonly authorAssociation: string;
  readonly author: { readonly login: string; readonly __typename: string } | null;
}

export const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 50) { nodes { id url authorAssociation author { login __typename } } }
      reviewThreads(first: 100) { nodes { isResolved path comments(last: 20) { nodes { id url authorAssociation author { login __typename } } } } }
    }
  }
}`;

const COLLABORATORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function parseComments(json: unknown): CommentRead {
  const data = (json as {
    data: {
      viewer: { login: string };
      repository: { pullRequest: { comments: { nodes: CommentNode[] }; reviewThreads: { nodes: { isResolved: boolean; path: string; comments: { nodes: CommentNode[] } }[] } } };
    };
  }).data;
  const pr = data.repository.pullRequest;
  const all = [
    ...pr.comments.nodes.map((node) => ({ node, path: undefined as string | undefined })),
    ...pr.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes.map((node) => ({ node, path: thread.path }))),
  ];
  // A bot's review comments on the code (Copilot's reviewer) are review feedback; its conversation comments (coverage,
  // dependency bots) are noise.
  const isBot = (node: CommentNode) => node.author?.__typename === "Bot";
  const counts = (node: CommentNode, path: string | undefined) =>
    node.author !== null && node.author.login !== data.viewer.login && (isBot(node) ? path !== undefined : COLLABORATORS.has(node.authorAssociation));
  return {
    unresolvedThreads: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    commentIds: all.map(({ node }) => node.id),
    comments: all
      .filter(({ node, path }) => counts(node, path))
      .map(({ node, path }) => ({ id: node.id, author: node.author!.login, ...(path ? { path } : {}), url: node.url, ...(isBot(node) ? { bot: true as const } : {}) })),
  };
}

const SHOWN = 3;

/** "new review comment by bob on src/a.ts (link)" for each comment not seen before, at most three. */
export function commentEvents(seen: readonly string[], comments: readonly PrComment[]): string[] {
  const known = new Set(seen);
  const all = comments.filter((c) => !known.has(c.id));
  // A bot's review comes as many comments at once: one line per bot.
  const bots = [...new Set(all.filter((c) => c.bot).map((c) => c.author))].map((author) => {
    const theirs = all.filter((c) => c.bot && c.author === author);
    return `${author} left ${theirs.length} review comment${theirs.length === 1 ? "" : "s"} (${theirs[0]!.url})`;
  });
  const fresh = all.filter((c) => !c.bot);
  if (bots.length > 0 && fresh.length === 0) return bots;
  const lines = fresh.slice(0, SHOWN).map((c) => (c.path ? `new review comment by ${c.author} on ${c.path} (${c.url})` : `new comment by ${c.author} (${c.url})`));
  return [...bots, ...(fresh.length > SHOWN ? [...lines, `and ${fresh.length - SHOWN} more new comments`] : lines)];
}
