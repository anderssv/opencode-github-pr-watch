/**
 * Messages waiting to be posted to a session, kept per process rather than per plugin instance: an instance replaced
 * by a reload can still be finishing a check, and what it queues must be sent by an instance that is still alive.
 */
export interface Queued {
  messages: string[];
  wake: boolean;
  alert: string[];
  /** Delivery attempts that failed or timed out. */
  attempts: number;
}

export interface Outbox {
  readonly queued: Map<string, Queued>;
  /** Posts one session's messages; registered by the newest live instance, removed when it is disposed. */
  deliverer?: { readonly owner: symbol; readonly deliver: (sessionID: string, entry: Queued) => Promise<void> };
}

export const newOutbox = (): Outbox => ({ queued: new Map() });

/** Adds a message; true when it is the session's first, so the caller starts the digest window. */
export function enqueue(outbox: Outbox, sessionID: string, text: string, wake: boolean, alert: boolean): boolean {
  const existing = outbox.queued.get(sessionID);
  const entry = existing ?? { messages: [], wake: false, alert: [], attempts: 0 };
  entry.messages.push(text);
  entry.wake ||= wake;
  if (alert) entry.alert.push(text);
  outbox.queued.set(sessionID, entry);
  return existing === undefined;
}

export function registerDeliverer(outbox: Outbox, owner: symbol, deliver: (sessionID: string, entry: Queued) => Promise<void>): void {
  outbox.deliverer = { owner, deliver };
}

export function releaseDeliverer(outbox: Outbox, owner: symbol): void {
  if (outbox.deliverer?.owner === owner) delete outbox.deliverer;
}

export const MAX_ATTEMPTS = 3;

export type FlushResult = "delivered" | "empty" | "retry" | "given-up";

/**
 * Sends a session's queued messages through the current deliverer. A failure, a timeout or no live instance puts
 * them back to be tried again ("retry"), up to MAX_ATTEMPTS; messages queued meanwhile join them.
 */
export async function flushOutbox(outbox: Outbox, sessionID: string, timeoutMs: number): Promise<FlushResult> {
  const entry = outbox.queued.get(sessionID);
  outbox.queued.delete(sessionID);
  if (!entry || entry.messages.length === 0) return "empty";
  const deliverer = outbox.deliverer;
  try {
    if (!deliverer) throw new Error("no live plugin instance");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      deliverer.deliver(sessionID, entry),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs))),
    ]).finally(() => clearTimeout(timer));
    return "delivered";
  } catch (err) {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) throw err;
    const later = outbox.queued.get(sessionID);
    outbox.queued.set(sessionID, {
      messages: [...entry.messages, ...(later?.messages ?? [])],
      wake: entry.wake || (later?.wake ?? false),
      alert: [...entry.alert, ...(later?.alert ?? [])],
      attempts,
    });
    return "retry";
  }
}
