import { describe, expect, test } from "bun:test";
import { resumedMessage, startFailed, startingMessage, startResult, watchStartedMessage } from "../core/messages";

describe("watchStartedMessage", () => {
  test("names the provider and the model that will judge changes", () => {
    const message = watchStartedMessage("acme/api#42", { providerID: "github-copilot", id: "claude-haiku-4.5" });

    expect(message).toContain("acme/api#42");
    expect(message).toContain("github-copilot/claude-haiku-4.5");
    expect(message).toContain("github-copilot only");
  });

  test("includes the PR's current state", () => {
    const message = watchStartedMessage("o/r#1", { providerID: "github-copilot", id: "claude-haiku" }, "summary: REVIEW_REQUIRED · checks PASS · branch OK · next: NEEDS_REVIEW");

    expect(message).toContain("summary: REVIEW_REQUIRED · checks PASS · branch OK · next: NEEDS_REVIEW");
  });
});

describe("resumedMessage", () => {
  test("names how many watches resumed, and which", () => {
    expect(resumedMessage(["o/a#1", "o/b#2"])).toBe("resumed 2 watches after restart: o/a#1, o/b#2");
    expect(resumedMessage(["o/a#1"])).toBe("resumed 1 watch after restart: o/a#1");
  });
});

describe("watchStartedMessage: what started it (plan 15)", () => {
  test("names the command that started an automatic watch", () => {
    const message = watchStartedMessage("o/r#42", { providerID: "github-copilot", id: "claude-haiku-4.5" }, undefined, "gh run rerun 38730000");
    expect(message.startsWith("Watching o/r#42 (started by gh run rerun 38730000).")).toBe(true);
  });
});

describe("watchStartedMessage: what will be reported (acme/admin#41)", () => {
  test("every change of step, including checks finishing, so silence means nothing changed; progress as the track", () => {
    const message = watchStartedMessage("o/r#1", { providerID: "github-copilot", id: "claude-haiku" });
    expect(message).toContain("Every change of where the PR is is reported, including checks finishing (passed or failed)");
    expect(message).toContain("no message means the PR is still where it was");
    expect(message).toContain("Progress within a step is sent as the PR's track, at most once a minute, without waking you");
  });
});

describe("background starts: watch_pr answers at once, the result comes as a message", () => {
  test("the immediate answer says the status follows", () => {
    expect(startingMessage("o/r#7")).toBe("Starting to watch o/r#7; its status follows in a message within about 15 seconds.");
  });

  test("watches that started only inform; a refusal or error wakes the agent, which has to act on it", () => {
    expect(startResult("Watching o/r#7. summary: x.")).toEqual({ text: "Watching o/r#7. summary: x.", wake: false });
    expect(startResult("Not watching o/r#7: closed. summary: x.")).toEqual({ text: "Not watching o/r#7: closed. summary: x.", wake: true });
    expect(startResult("Watching o/r#1.\nNot a PR reference: foo")).toEqual({ text: "Watching o/r#1.\nNot a PR reference: foo", wake: true });
    expect(startResult("")).toBeUndefined();
  });

  test("a failed start says what failed", () => {
    expect(startFailed("o/r#7", new Error("HTTP 502"))).toEqual({ text: "Could not start watching o/r#7: HTTP 502", wake: true });
  });
});
