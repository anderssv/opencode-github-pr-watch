/**
 * GitHub's REST budget (5,000 calls an hour per user). When it runs low, background calls are spread over what is
 * left until the reset instead of spending it and then stopping for the rest of the hour. Starts and the user's own
 * `gh` use keep a reserve.
 */
export interface RestBudget {
  readonly remaining: number;
  readonly resetAt: number;
}

const SLOW_BELOW = 1_000;
const RESERVE = 200;

export function paceDelay(budget: RestBudget | undefined, now: number, lastCallAt: number): number {
  if (!budget || budget.resetAt <= now || budget.remaining >= SLOW_BELOW) return 0;
  const left = budget.remaining - RESERVE;
  if (left <= 0) return budget.resetAt - now;
  const spacing = Math.ceil((budget.resetAt - now) / left);
  return Math.max(0, lastCallAt + spacing - now);
}

export function parseRateLimit(json: string): RestBudget {
  const core = (JSON.parse(json) as { resources: { core: { remaining: number; reset: number } } }).resources.core;
  return { remaining: core.remaining, resetAt: core.reset * 1000 };
}

const clock = (time: number) => new Date(time).toTimeString().slice(0, 5);

export function budgetText(budget: RestBudget | undefined, now: number): string | undefined {
  if (!budget || budget.resetAt <= now || budget.remaining >= SLOW_BELOW) return undefined;
  return `GitHub budget low (${budget.remaining} calls left until ${clock(budget.resetAt)}); checks are slowed down`;
}
