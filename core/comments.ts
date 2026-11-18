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
  const counts = (node: CommentNode) =>
    node.author !== null && node.author.__typename !== "Bot" && node.author.login !== data.viewer.login && COLLABORATORS.has(node.authorAssociation);
  return {
    unresolvedThreads: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    commentIds: all.map(({ node }) => node.id),
    comments: all.filter(({ node }) => counts(node)).map(({ node, path }) => ({ id: node.id, author: node.author!.login, ...(path ? { path } : {}), url: node.url })),
  };
}

const SHOWN = 3;

/** "new review comment by bob on src/a.ts (link)" for each comment not seen before, at most three. */
export function commentEvents(seen: readonly string[], comments: readonly PrComment[]): string[] {
  const known = new Set(seen);
  const fresh = comments.filter((c) => !known.has(c.id));
  const lines = fresh.slice(0, SHOWN).map((c) => (c.path ? `new review comment by ${c.author} on ${c.path} (${c.url})` : `new comment by ${c.author} (${c.url})`));
  return fresh.length > SHOWN ? [...lines, `and ${fresh.length - SHOWN} more new comments`] : lines;
}
