import { describe, expect, test } from "bun:test";
import { GhQueue } from "../core/gh-queue";

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

describe("GhQueue: at most N GitHub calls at a time, starts before background checks", () => {
  test("runs no more than the limit at once", async () => {
    const queue = new GhQueue(2);
    let running = 0;
    let most = 0;
    const work = () => queue.run("background", async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
    await Promise.all([work(), work(), work(), work(), work()]);
    expect(most).toBe(2);
  });

  test("a waiting first call goes ahead of waiting background calls", async () => {
    const queue = new GhQueue(1);
    const order: string[] = [];
    const busy = gate();
    const first = queue.run("background", () => busy.opened.then(() => void order.push("running")));
    const later = [
      queue.run("background", async () => void order.push("bg1")),
      queue.run("background", async () => void order.push("bg2")),
      queue.run("first", async () => void order.push("start")),
    ];
    busy.open();
    await Promise.all([first, ...later]);
    expect(order).toEqual(["running", "start", "bg1", "bg2"]);
  });

  test("a failing call frees its place and passes the error on", async () => {
    const queue = new GhQueue(1);
    await expect(queue.run("first", async () => { throw new Error("gh: 404"); })).rejects.toThrow("gh: 404");
    expect(await queue.run("background", async () => "ok")).toBe("ok");
  });
});
