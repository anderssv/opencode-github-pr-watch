import type { ModelRef } from "./model-guard";

export function watchStartedMessage(id: string, model: ModelRef, summary?: string, startedBy?: string): string {
  return (
    `Watching ${id}${startedBy ? ` (started by ${startedBy})` : ""}.${summary ? ` ${summary}.` : ""} ` +
    "Every change of where the PR is is reported, including checks finishing (passed or failed), review, merge and deploy, " +
    "so no message means the PR is still where it was. " +
    "Progress within a step is sent as the PR's track, at most once a minute, without waking you. " +
    `Other changes are judged by ${model.providerID}/${model.id} (re-checked before every call; ${model.providerID} only), which reports anything unexpected.`
  );
}

export const resumedMessage = (ids: readonly string[]) =>
  `resumed ${ids.length} watch${ids.length === 1 ? "" : "es"} after restart: ${ids.join(", ")}`;

/** watch_pr's answer: the slow first check runs in the background, and its result comes as a message. */
export const startingMessage = (pr: string) => `Starting to watch ${pr}; its status follows in a message within about 15 seconds.`;

/** The background start's result. Watches that started only inform; anything else needs the agent. Nothing to say: undefined. */
export function startResult(text: string): { text: string; wake: boolean } | undefined {
  if (text.trim() === "") return undefined;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return { text, wake: lines.some((line) => !/^(Watching|Replaced the earlier watch|Following run) /.test(line)) };
}

export const startFailed = (pr: string, err: unknown) => ({
  text: `Could not start watching ${pr}: ${err instanceof Error ? err.message : String(err)}`,
  wake: true,
});
