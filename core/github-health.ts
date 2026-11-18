/**
 * GitHub limiting the gh user, or the network being down, fails every call, not just one. Then every watch pauses
 * together: calls are refused at once until the pause is over, and the pause grows while it keeps failing.
 */
export type HealthKind = "rate-limit" | "network";

export interface GithubHealth {
  readonly kind: HealthKind;
  readonly until: number;
  readonly failures: number;
}

const RATE_LIMIT = /rate limit|HTTP 429|too many requests/i;
const NETWORK = /error connecting to|no such host|could not resolve host|TLS handshake timeout|connection (reset|refused)|network is unreachable|i\/o timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;

export function classifyGhError(message: string): HealthKind | undefined {
  if (RATE_LIMIT.test(message)) return "rate-limit";
  if (NETWORK.test(message)) return "network";
  return undefined;
}

const FIRST: Record<HealthKind, number> = { "rate-limit": 5 * 60_000, network: 30_000 };
const MOST: Record<HealthKind, number> = { "rate-limit": 30 * 60_000, network: 5 * 60_000 };

export function healthAfter(before: GithubHealth | undefined, outcome: HealthKind | "ok", now: number): GithubHealth | undefined {
  if (outcome === "ok") return undefined;
  const failures = before?.kind === outcome ? before.failures + 1 : 1;
  return { kind: outcome, until: now + Math.min(MOST[outcome], FIRST[outcome] * 2 ** (failures - 1)), failures };
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

export function pausedText(health: GithubHealth | undefined, now: number): string | undefined {
  if (!health || health.until <= now) return undefined;
  return `${health.kind === "rate-limit" ? "GitHub is rate limiting" : "GitHub can't be reached"}; checking again at ${clock(health.until)}`;
}
