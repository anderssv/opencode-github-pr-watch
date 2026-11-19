import { describe, expect, test } from "bun:test";
import { enqueue, flushOutbox, newOutbox, registerDeliverer, releaseDeliverer, type Queued } from "../core/outbox";

const recorder = () => {
  const sent: { sessionID: string; messages: string[]; wake: boolean }[] = [];
  return { sent, deliver: async (sessionID: string, entry: Queued) => void sent.push({ sessionID, messages: entry.messages, wake: entry.wake }) };
};

describe("outbox: messages survive a reload between queueing and sending", () => {
  test("queued by a replaced instance, sent by the newest", async () => {
    const outbox = newOutbox();
    const old = recorder();
    const fresh = recorder();
    registerDeliverer(outbox, Symbol("old"), old.deliver);
    expect(enqueue(outbox, "s1", "a#1: checks passed", false, true)).toBe(true);
    expect(enqueue(outbox, "s1", "a#2: progress", false, false)).toBe(false);
    registerDeliverer(outbox, Symbol("new"), fresh.deliver);
    expect(await flushOutbox(outbox, "s1", 1000)).toBe("delivered");
    expect(old.sent).toEqual([]);
    expect(fresh.sent).toEqual([{ sessionID: "s1", messages: ["a#1: checks passed", "a#2: progress"], wake: false }]);
  });

  test("a disposed instance only removes itself", () => {
    const outbox = newOutbox();
    const fresh = Symbol("new");
    registerDeliverer(outbox, fresh, recorder().deliver);
    releaseDeliverer(outbox, Symbol("old"));
    expect(outbox.deliverer?.owner).toBe(fresh);
    releaseDeliverer(outbox, fresh);
    expect(outbox.deliverer).toBeUndefined();
  });

  test("a delivery that hangs times out and is kept for another try, with what came meanwhile", async () => {
    const outbox = newOutbox();
    registerDeliverer(outbox, Symbol("dead"), () => new Promise<void>(() => {}));
    enqueue(outbox, "s1", "a#1: checks passed", false, true);
    const flushing = flushOutbox(outbox, "s1", 20);
    enqueue(outbox, "s1", "a#1: approved", true, true);
    expect(await flushing).toBe("retry");
    expect(outbox.queued.get("s1")).toEqual({ messages: ["a#1: checks passed", "a#1: approved"], wake: true, alert: ["a#1: checks passed", "a#1: approved"], attempts: 1 });
  });

  test("no live instance: kept; after the last attempt it fails", async () => {
    const outbox = newOutbox();
    enqueue(outbox, "s1", "a#1: x", false, false);
    expect(await flushOutbox(outbox, "s1", 20)).toBe("retry");
    expect(await flushOutbox(outbox, "s1", 20)).toBe("retry");
    await expect(flushOutbox(outbox, "s1", 20)).rejects.toThrow("no live plugin instance");
    expect(outbox.queued.has("s1")).toBe(false);
  });

  test("nothing queued: nothing sent", async () => {
    expect(await flushOutbox(newOutbox(), "s1", 20)).toBe("empty");
  });
});
