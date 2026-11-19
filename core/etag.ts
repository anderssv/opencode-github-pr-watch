/**
 * Conditional REST requests: GitHub answers "304 Not Modified" to a request carrying the last answer's ETag when
 * nothing changed, and a 304 doesn't count against the rate limit. Every plain `gh api <path>` GET goes through here.
 */
export type EtagStore = Map<string, { readonly etag: string; readonly body: string }>;

export interface HttpAnswer {
  readonly status: number;
  readonly etag?: string;
  readonly body: string;
}

export function parseHttp(raw: string): HttpAnswer {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, "") : "";
  const [statusLine = "", ...headers] = head.split(/\r?\n/);
  const status = Number(statusLine.match(/^HTTP\/\S+ (\d{3})/)?.[1] ?? 0);
  const etag = headers.find((h) => /^etag:/i.test(h))?.replace(/^etag:\s*/i, "");
  return { status, ...(etag ? { etag } : {}), body };
}

/** `gh api <path>` with at most `-H` headers: a GET whose answer can be asked for conditionally. */
export function isPlainGet(args: readonly string[]): boolean {
  if (args[0] !== "api" || !args[1] || args[1].startsWith("-") || args[1] === "graphql") return false;
  const rest = args.slice(2);
  return rest.length % 2 === 0 && rest.every((arg, i) => (i % 2 === 0 ? arg === "-H" : !/^if-none-match:/i.test(arg)));
}

const MAX_KEPT = 2_000;

/**
 * `fetch` makes the request (with If-None-Match when given an ETag) and returns gh's raw answer, headers included.
 * An error status throws with GitHub's message, worded like gh's own errors so the rate-limit and network checks
 * recognise it.
 */
export async function conditionalGet(store: EtagStore, key: string, fetch: (etag?: string) => Promise<string>): Promise<string> {
  const kept = store.get(key);
  let answer = parseHttp(await fetch(kept?.etag));
  if (answer.status === 304 && kept?.body !== undefined) return kept.body;
  if (answer.status === 304) answer = parseHttp(await fetch());
  if (answer.status >= 200 && answer.status < 300) {
    if (answer.etag) {
      store.delete(key);
      if (store.size >= MAX_KEPT) store.delete(store.keys().next().value!);
      store.set(key, { etag: answer.etag, body: answer.body });
    }
    return answer.body;
  }
  let message = answer.body.trim();
  try {
    message = (JSON.parse(answer.body) as { message?: string }).message ?? message;
  } catch {
    // Not JSON: keep the text.
  }
  throw new Error(`gh: ${message} (HTTP ${answer.status})`);
}
